// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IOrderHandler } from "./IOrderHandler.sol";
import { IClearingHouse, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IHubbleBibliophile } from "../precompiles/IHubbleBibliophile.sol";
import { IJuror } from "../precompiles/Juror.sol";
import { IHubbleReferral } from "../HubbleReferral.sol";

interface ILimitOrderBook is IOrderHandler {
    /**
     * @notice Order struct
     * @param ammIndex Market id to place the order. In Hubble, market ids are sequential and start from 0
     * @param trader Address of the trader
     * @param baseAssetQuantity Amount of base asset to buy/sell. Positive for buy, negative for sell. Has to be multiplied by 10^18.
     *        It has to be a multiple of the minimum order size of a market.
     * @param price Price of the order. Has to be multiplied by 10^6
     * @param salt Random number to ensure unique order hashes
     * @param reduceOnly Whether the order is reduce only or not. Reduce only orders do not reserve any margin.
    */
    struct Order {
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
        bool reduceOnly;
    }

    struct OrderInfo {
        uint blockPlaced;
        int256 filledAmount;
        uint256 reservedMargin;
        OrderStatus status;
    }

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, Order order, uint timestamp);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event SkippedCancelOrder(address indexed trader, bytes32 indexed orderHash, uint timestamp);

    /**
     * @notice Place multiple orders
     * Corresponding to each order, the system will reserve some margin that is required to keep the leverage within premissible limits if/when the order is executed
     * @dev Even if one order fails to be placed for whatever reason, entire tx will revert and all other orders will also fail to be placed
    */
    function placeOrders(Order[] memory orders) external;

    /**
     * @notice Place an order
     * @dev even for a single order it is slightly more gas efficient to use placeOrders
    */
    function placeOrder(Order memory order) external;

    /**
     * @notice Cancel multiple orders.
     * Even a validator is allowed to cancel certain orders on the trader's behalf. This happens when there is not sufficient margin to execute the order.
     * @dev If one order fails to be cancelled for whatever reason, tx will not revert and all other cancellations will be processed.
    */
    function cancelOrders(Order[] memory orders) external;

    /**
     * @notice Cancel multiple orders.
     * Even a validator is allowed to cancel certain orders on the trader's behalf. This happens when there is not sufficient margin to execute the order.
     * @dev Even if one order fails to be cancelled for whatever reason, entire tx will revert and all other orders will also fail to be cancelled.
    */
    function cancelOrdersAtomic(Order[] memory orders) external;

    /**
     * @notice Cancel an order
     * @dev even for a cancelling a single order it is slightly more gas efficient to use cancelOrders
    */
    function cancelOrder(Order memory order) external;
    function getOrderHash(Order memory order) external view returns (bytes32);
    function orderStatus(bytes32 orderHash) external view returns (OrderInfo memory);

    /**
     * @dev These functions if defined in IOrderBook throw a weird compilation error, hence putting them here
    */
    function isTradingAuthority(address signer, address trader) external view returns(bool);
    function isValidator(address validator) external view returns(bool);
}

/**
 * @title Takes care of order placement, cancellations.
 *        Mostly has only first level checks about validatiy of orders. More deeper checks and interactions happen in ClearingHouse.
 * @notice This contract is used by users to place/cancel orders.
 * @dev At several places we are using something called a bibliophile. This is a special contract (precompile) that is deployed at a specific address.
 * But there is identical code in this contract that can be used as a fallback if the precompile is not available.
*/
contract LimitOrderBook is ILimitOrderBook, VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2;
    string constant NOT_IS_MULTIPLE = "not multiple";

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    mapping(bytes32 => OrderInfo) public orderInfo; // SLOT_53 !!! used in precompile !!!
    mapping(address => bool) public isValidator; // SLOT_54 (not used in precompile)

    /**
    * @notice maps the address of the trader to the amount of reduceOnlyAmount for each amm
    * trader => ammIndex => reduceOnlyAmount
    */
    mapping(address => mapping(uint => int256)) public reduceOnlyAmount; // SLOT_55

    // cache some variables for quick assertions
    // min size for each AMM, array index is the ammIndex
    int256[] public minSizes; // SLOT_56
    uint public minAllowableMargin; // SLOT_57
    uint public takerFee; // SLOT_58
    IHubbleBibliophile public bibliophile; // SLOT_59

    uint256 public useNewPricingAlgorithm;  // SLOT_60 - declared as uint256 to take 1 full slot

    // trader => tradingAuthority => true/false
    mapping(address => mapping(address => bool)) public isTradingAuthority; // SLOT_61

    mapping(uint8 => address) public orderHandlers;
    IJuror public juror;
    address public referral;

    uint256[45] private __gap;

    modifier onlyValidator {
        require(isValidator[msg.sender], "OB.only_validator");
        _;
    }

    modifier onlyClearingHouse {
        require(msg.sender == address(clearingHouse), "OB.only_clearingHouse");
        _;
    }

    constructor(address _clearingHouse, address _marginAccount) {
        clearingHouse = IClearingHouse(_clearingHouse);
        marginAccount = IMarginAccount(_marginAccount);
    }

    function initialize(
        string memory _name,
        string memory _version,
        address _governance
    ) external initializer {
        __EIP712_init(_name, _version);
        _setGovernace(_governance);
    }

    /* ****************** */
    /*    Place Orders    */
    /* ****************** */

    /**
     * @inheritdoc ILimitOrderBook
    */
    function placeOrder(Order memory order) external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        placeOrders(_orders);

    }

    /**
     * @inheritdoc ILimitOrderBook
    */
    function placeOrders(Order[] memory orders) public whenNotPaused {
        address trader = orders[0].trader;
        address sender = _msgSender();
        assertTradingAuthority(trader, sender);
        (int[] memory posSizes, uint[] memory upperBounds) = bibliophile.getPositionSizesAndUpperBoundsForMarkets(trader);
        uint reserveAmount;
        for (uint i = 0; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            reserveAmount += _placeOrder(orders[i], posSizes[orders[i].ammIndex], upperBounds[orders[i].ammIndex]);
        }
        if (reserveAmount != 0) {
            marginAccount.reserveMargin(trader, reserveAmount);
        }
    }

    function assertTradingAuthority(address trader, address sender) public view {
        require(trader == sender || isTradingAuthority[trader][sender], "OB.no trading authority");
    }

    /**
     * @dev has some special handling for reduceOnly orders
    */
    function _placeOrder(Order memory order, int size, uint upperBound) internal returns (uint reserveAmount) {
        // orders should be multiple of pre-defined minimum quantity to prevent spam with dust orders
        require(isMultiple(order.baseAssetQuantity, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);

        bytes32 orderHash = getOrderHash(order);
        // order should not exist in the orderStatus map already
        require(orderInfo[orderHash].status == OrderStatus.Invalid, "already exists");

        // reduce only orders should only reduce the position size. They need a bit of special handling.
        if (order.reduceOnly) {
            require(isOppositeSign(size, order.baseAssetQuantity), "OB_reduce_only_order_must_reduce_position");
            // track the total size of all the reduceOnly orders for a trader in a particular market
            reduceOnlyAmount[order.trader][order.ammIndex] += abs(order.baseAssetQuantity);
            // total size of reduce only orders should not exceed the position size
            require(abs(size) >= reduceOnlyAmount[order.trader][order.ammIndex], "OB_reduce_only_amount_exceeded");
        } else {
            /**
            * Don't allow trade in opposite direction of existing position size if there is a reduceOnly order
            * in case of liquidation, size == 0 && reduceOnlyAmount != 0 is possible
            * in that case, we don't not allow placing a new order in any direction, must cancel reduceOnly order first
            * in normal case, size = 0 => reduceOnlyAmount = 0
            */
            if (isOppositeSign(size, order.baseAssetQuantity) || size == 0) {
                require(reduceOnlyAmount[order.trader][order.ammIndex] == 0, "OB_cancel_reduce_only_order_first");
            }
            // reserve margin for the order
            reserveAmount = getRequiredMargin(order.baseAssetQuantity, order.price, upperBound);
        }

        // add orderInfo for the corresponding orderHash
        orderInfo[orderHash] = OrderInfo(block.number, 0, reserveAmount, OrderStatus.Placed);
        emit OrderPlaced(order.trader, orderHash, order, block.timestamp);
    }

    /* ****************** */
    /*    Cancel Orders   */
    /* ****************** */

    /**
     * @inheritdoc ILimitOrderBook
    */
    function cancelOrder(Order memory order) override external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        cancelOrders(_orders);
    }

    /**
     * @inheritdoc ILimitOrderBook
    */
    function cancelOrders(Order[] memory orders) override public {
        address trader = orders[0].trader;
        address sender = _msgSender();
        if (trader != sender && !isTradingAuthority[trader][sender]) {
            require(isValidator[sender], "OB_invalid_sender");
            return _cancelOrders(orders, true, false);
        }
        _cancelOrders(orders, false, false);
    }

     /**
     * @inheritdoc ILimitOrderBook
    */
    function cancelOrdersAtomic(Order[] memory orders) override external {
        assertTradingAuthority(orders[0].trader, _msgSender());
        _cancelOrders(orders, false, true);
    }

    function _cancelOrders(Order[] memory orders, bool checkAvailableMargin, bool makeNoise) internal {
        address trader = orders[0].trader;
        int availableMargin;
        uint releaseMargin;
        if (checkAvailableMargin) {
            availableMargin = marginAccount.getAvailableMargin(trader);
        }

        for (uint i; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            bytes32 orderHash = getOrderHash(orders[i]);
            if (orderInfo[orderHash].status != OrderStatus.Placed) {
                if (makeNoise) {
                    revert("OB_Order_does_not_exist");
                }
                emit SkippedCancelOrder(trader, orderHash, block.timestamp);
                continue;
            }
            if (checkAvailableMargin && availableMargin >= 0) {
                if (makeNoise) {
                    revert("OB_available_margin_not_negative");
                }
                emit SkippedCancelOrder(trader, orderHash, block.timestamp);
                continue;
            }
            uint release = _cancelOrder(orders[i], orderHash);
            availableMargin += int(release);
            releaseMargin += release;
        }
        if (releaseMargin != 0) {
            marginAccount.releaseMargin(trader, releaseMargin);
        }
    }

    function _cancelOrder(Order memory order, bytes32 orderHash) internal returns (uint releaseMargin) {
        address trader = order.trader;
        orderInfo[orderHash].status = OrderStatus.Cancelled;
        if (order.reduceOnly) {
            int unfilledAmount = abs(order.baseAssetQuantity - orderInfo[orderHash].filledAmount);
            reduceOnlyAmount[trader][order.ammIndex] -= unfilledAmount;
        } else {
            releaseMargin = orderInfo[orderHash].reservedMargin;
        }
        _deleteOrderInfo(orderHash);
        emit OrderCancelled(trader, orderHash, block.timestamp);
    }

    /* ****************** */
    /*       View         */
    /* ****************** */

    function orderStatus(bytes32 orderHash) override external view returns (OrderInfo memory) {
        return orderInfo[orderHash];
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /**
    * @notice Get the margin required to place an order
    * @dev includes trade fee (taker fee).
    * For a short order, margin is calculated using the upper bound price of the market.
    */
    function getRequiredMargin(int256 baseAssetQuantity, uint256 price, uint upperBound) public view returns(uint256 requiredMargin) {
        if (baseAssetQuantity < 0 && price < upperBound) {
            price = upperBound;
        }
        uint quoteAsset = abs(baseAssetQuantity).toUint256() * price / 1e18;
        requiredMargin = quoteAsset * minAllowableMargin / 1e6;
        requiredMargin += quoteAsset * takerFee / 1e6;
    }

    function updateOrder(bytes calldata encodedOrder, bytes calldata metadata) external {
        require(msg.sender == address(this), "only default orderBook");

        Order memory order = abi.decode(encodedOrder, (Order));
        (bytes32 orderHash, int256 fillAmount) = abi.decode(metadata, (bytes32, int256));

        // it has already been validated in juror that order is not being overfilled
        orderInfo[orderHash].filledAmount += fillAmount;

        // update order status if filled and free up reserved margin
        if (order.reduceOnly) {
            // free up the reduceOnly quota
            reduceOnlyAmount[order.trader][order.ammIndex] -= abs(fillAmount);
            if (orderInfo[orderHash].filledAmount == order.baseAssetQuantity) {
                orderInfo[orderHash].status = OrderStatus.Filled;
                _deleteOrderInfo(orderHash);
            }
        } else {
            uint reservedMargin = orderInfo[orderHash].reservedMargin;
            if (orderInfo[orderHash].filledAmount == order.baseAssetQuantity) {
                orderInfo[orderHash].status = OrderStatus.Filled;
                marginAccount.releaseMargin(order.trader, reservedMargin);
                _deleteOrderInfo(orderHash);
            } else {
                // even though the fill price might be different from the order price;
                // we use the order price to free up the margin because the order price is the price at which the margin was reserved.
                uint utilisedMargin = uint(abs(fillAmount)) * reservedMargin / uint(abs(order.baseAssetQuantity));
                // need to track this so we can free up the margin when the order is fulfilled/cancelled without leaving any dust margin reserved from precision loss from divisions
                orderInfo[orderHash].reservedMargin -= utilisedMargin;
                marginAccount.releaseMargin(order.trader, utilisedMargin);
            }
        }
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    /**
    * @notice Deletes everything except status and filledAmount from orderInfo
    * @dev cannot delete order status because then same order can be placed again
    */
    function _deleteOrderInfo(bytes32 orderHash) internal {
        delete orderInfo[orderHash].blockPlaced;
        delete orderInfo[orderHash].reservedMargin;
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    /**
    * @notice returns true if x and y have opposite signs
    * @dev it considers 0 to have positive sign
    */
    function isOppositeSign(int256 x, int256 y) internal pure returns (bool) {
        return (x ^ y) < 0;
    }

    /**
    * @notice checks `x` is non-zero and whether `x` is multiple of `y`
    * @dev assumes y is positive
    * @return `true` if `x` is multiple of `y` and abs(x) >= y
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }

    function setReferral(address _referral) external onlyGovernance {
        referral = _referral;
    }
}
