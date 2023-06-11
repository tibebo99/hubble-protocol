// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IClearingHouse, IOrderBook, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IHubbleBibliophile } from "../precompiles/IHubbleBibliophile.sol";

contract OrderBook is IOrderBook, VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2;
    string constant NOT_IS_MULTIPLE = "OB.not_multiple";

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    mapping(bytes32 => OrderInfo) public orderInfo;
    mapping(address => bool) public isValidator; // SLOT_54 (not used in precompile)

    /**
    * @notice maps the address of the trader to the amount of reduceOnlyAmount for each amm
    * trader => ammIndex => reduceOnlyAmount
    */
    mapping(address => mapping(uint => int256)) public reduceOnlyAmount;

    // cache some variables for quick assertions
    int256[] public minSizes; // min size for each AMM, array index is the ammIndex
    uint public minAllowableMargin;
    uint public takerFee;
    IHubbleBibliophile public bibliophile;

    uint256 public useNewPricingAlgorithm; // declared as uint256 to take 1 full slot
    uint256[49] private __gap;

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
        // this is problematic for re-initialization but as long as we are not changing gov address across runs, it wont be a problem
        _setGovernace(_governance);
    }

    function executeMatchedOrders(
        Order[2] memory orders,
        int256 fillAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        MatchInfo[2] memory matchInfo;
        matchInfo[0].orderHash = getOrderHash(orders[0]);
        matchInfo[1].orderHash = getOrderHash(orders[1]);

        uint fillPrice;
        (fillPrice, matchInfo[0].mode, matchInfo[1].mode) = useNewPricingAlgorithm == 1 ?
            bibliophile.validateOrdersAndDetermineFillPrice(orders, [matchInfo[0].orderHash, matchInfo[1].orderHash], fillAmount) :
            _validateOrdersAndDetermineFillPrice(orders, [matchInfo[0].orderHash, matchInfo[1].orderHash], fillAmount);

        try clearingHouse.openComplementaryPositions(orders, matchInfo, fillAmount, fillPrice) returns (uint256 openInterestNotional) {
            _updateOrder(orders[0], matchInfo[0].orderHash, fillAmount);
            _updateOrder(orders[1], matchInfo[1].orderHash, -fillAmount);
            emit OrdersMatched(
                matchInfo[0].orderHash,
                matchInfo[1].orderHash,
                fillAmount.toUint256(), // asserts fillAmount is +ve
                fillPrice,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 orderHash, string memory reason) {
                emit OrderMatchingError(orderHash, reason);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        } /* catch (bytes memory err) {
            // we do not any special handling for other generic type errors
            // they can revert the entire tx as usual
        } */
    }

    function _validateOrdersAndDetermineFillPrice(
        Order[2] memory orders,
        bytes32[2] memory orderHashes,
        int256 fillAmount
    )   internal
        view
        returns (uint256 fillPrice, OrderExecutionMode mode0, OrderExecutionMode mode1)
    {
        // Checks and Effects
        require(orderInfo[orderHashes[0]].status == OrderStatus.Placed, "OB_invalid_order");
        require(orderInfo[orderHashes[1]].status == OrderStatus.Placed, "OB_invalid_order");
        require(orders[0].baseAssetQuantity > 0, "OB_order_0_is_not_long");
        require(orders[1].baseAssetQuantity < 0, "OB_order_1_is_not_short");
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");
        require(orders[0].ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");

        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(fillAmount, minSizes[orders[0].ammIndex]), NOT_IS_MULTIPLE);

        uint blockPlaced0 = orderInfo[orderHashes[0]].blockPlaced;
        uint blockPlaced1 = orderInfo[orderHashes[1]].blockPlaced;

        if (blockPlaced0 < blockPlaced1) {
            mode0 = OrderExecutionMode.Maker;
            fillPrice = orders[0].price;
        } else if (blockPlaced0 > blockPlaced1) {
            mode1 = OrderExecutionMode.Maker;
            fillPrice = orders[1].price;
        } else { // both orders are placed in the same block, not possible to determine what came first in solidity
            // executing both orders as taker order
            mode0 = OrderExecutionMode.SameBlock;
            mode1 = OrderExecutionMode.SameBlock;
            // Bulls (Longs) are our friends. We give them a favorable price in this corner case
            fillPrice = orders[1].price;
        }

        _validateSpread(orders[0].ammIndex, fillPrice, false);
    }

    function _validateSpread(uint ammIndex, uint256 price, bool isLiquidation) internal view {
        IAMM amm = IAMM(clearingHouse.amms(ammIndex));
        uint spreadLimit = isLiquidation ? amm.maxLiquidationPriceSpread() : amm.maxOracleSpreadRatio();
        uint256 oraclePrice = amm.getUnderlyingPrice();

        uint bound = oraclePrice * (1e6 + spreadLimit) / 1e6;
        require(price <= bound, "AMM.price_GT_bound");
        // if spreadLimit >= 1e6 it means that 100% variation is allowed which means shorts at $0 will also pass.
        // so we don't need to check for that case
        if (spreadLimit < 1e6) {
            bound = oraclePrice * (1e6 - spreadLimit) / 1e6;
            require(price >= bound, "AMM.price_LT_bound");
        }
    }

    function placeOrder(Order memory order) external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        placeOrders(_orders);
    }

    function placeOrders(Order[] memory orders) public whenNotPaused {
        address trader = orders[0].trader;
        int[] memory posSizes = _getPositionSizes(trader);
        uint reserveAmount;
        for (uint i = 0; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            reserveAmount += _placeOrder(orders[i], posSizes[orders[i].ammIndex]);
        }
        if (reserveAmount != 0) {
            marginAccount.reserveMargin(trader, reserveAmount);
        }
    }

    function _getPositionSizes(address trader) internal view returns (int[] memory) {
        if (address(bibliophile) != address(0)) {
            // precompile magic allows us to execute this for a fixed 1k gas
            return bibliophile.getPositionSizes(trader);
        }
        uint numAmms = clearingHouse.getAmmsLength();
        int[] memory posSizes = new int[](numAmms);
        for (uint i; i < numAmms; ++i) {
            (posSizes[i],,,) = IAMM(clearingHouse.amms(i)).positions(trader);
        }
        return posSizes;
    }

    function _placeOrder(Order memory order, int size) internal returns (uint reserveAmount) {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        // require(order.validUntil == 0, "OB_expiring_orders_not_supported");
        // order.baseAssetQuantity should be multiple of minSizeRequirement
        require(isMultiple(order.baseAssetQuantity, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);

        bytes32 orderHash = getOrderHash(order);
        // order should not exist in the orderStatus map already
        require(orderInfo[orderHash].status == OrderStatus.Invalid, "OB_Order_already_exists");

        if (order.reduceOnly) {
            require(isOppositeSign(size, order.baseAssetQuantity), "OB_reduce_only_order_must_reduce_position");
            reduceOnlyAmount[order.trader][order.ammIndex] += abs(order.baseAssetQuantity);
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
            reserveAmount = getRequiredMargin(order.baseAssetQuantity, order.price);
        }

        // add orderInfo for the corresponding orderHash
        orderInfo[orderHash] = OrderInfo(block.number, 0, reserveAmount, OrderStatus.Placed);
        emit OrderPlaced(order.trader, orderHash, order, block.timestamp);
    }

    function cancelOrder(Order memory order) override external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        cancelOrders(_orders);
    }

    function cancelOrders(Order[] memory orders) override public {
        address trader = orders[0].trader;
        uint releaseMargin;
        for (uint i; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            releaseMargin += _cancelOrder(orders[i]);
        }
        if (releaseMargin != 0) {
            marginAccount.releaseMargin(trader, releaseMargin);
        }
    }

    function _cancelOrder(Order memory order) internal returns (uint releaseMargin) {
        bytes32 orderHash = getOrderHash(order);
        // order status should be placed
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_Order_does_not_exist");

        address trader = order.trader;
        if (msg.sender != trader) {
            require(isValidator[msg.sender], "OB_invalid_sender");
            // allow cancellation of order by validator if availableMargin < 0
            require(marginAccount.getAvailableMargin(trader) < 0, "OB_available_margin_not_negative");
        }

        orderInfo[orderHash].status = OrderStatus.Cancelled;
        // update reduceOnlyAmount
        if (order.reduceOnly) {
            int unfilledAmount = abs(order.baseAssetQuantity - orderInfo[orderHash].filledAmount);
            reduceOnlyAmount[trader][order.ammIndex] -= unfilledAmount;
        } else {
            releaseMargin = orderInfo[orderHash].reservedMargin;
        }

        _deleteOrderInfo(orderHash);
        emit OrderCancelled(trader, orderHash, block.timestamp);
    }

    function settleFunding() external whenNotPaused onlyValidator {
        clearingHouse.settleFunding();
    }

    /**
     * @dev assuming one order is in liquidation zone and other is out of it
     * @notice liquidate trader
     * @param trader trader to liquidate
     * @param order order to match when liquidating for a particular amm
     * @param liquidationAmount baseAsset amount being traded/liquidated.
     *        liquidationAmount!=0 is validated in amm.liquidatePosition
    */
    function liquidateAndExecuteOrder(
        address trader,
        Order calldata order,
        uint256 liquidationAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        bytes32 orderHash = getOrderHash(order);
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_invalid_order");
        uint fillPrice = useNewPricingAlgorithm == 1 ?
            bibliophile.validateLiquidationOrderAndDetermineFillPrice(order, liquidationAmount.toInt256()) :
            _validateLiquidationOrderAndDetermineFillPrice(order, liquidationAmount.toInt256());

        int256 fillAmount = liquidationAmount.toInt256();
        if (order.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1;
        }

        MatchInfo memory matchInfo = MatchInfo({
            orderHash: orderHash,
            mode: OrderExecutionMode.Maker // execute matching order as maker order
        });

        try clearingHouse.liquidate(order, matchInfo, fillAmount, fillPrice, trader) returns (uint256 openInterestNotional) {
            _updateOrder(order, matchInfo.orderHash, fillAmount);
            emit LiquidationOrderMatched(
                trader,
                matchInfo.orderHash,
                liquidationAmount,
                order.price,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 _orderHash, string memory reason) {
                if (matchInfo.orderHash == _orderHash) { // err in openPosition for the order
                    emit OrderMatchingError(_orderHash, reason);
                    reason = "OrderMatchingError";
                } // else err in liquidating the trader; but we emit this either ways so that we can track liquidation didnt succeed for whatever reason
                emit LiquidationError(trader, _orderHash, reason, liquidationAmount);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        } /* catch (bytes memory err) {
            // we do not any special handling for other generic type errors
            // they can revert the entire tx as usual
        } */
    }

    function _validateLiquidationOrderAndDetermineFillPrice(Order memory order, int256 liquidationAmount) internal view returns(uint256 fillPrice) {
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(liquidationAmount, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);
        fillPrice = order.price;
        _validateSpread(order.ammIndex, fillPrice, true);
    }

    /* ****************** */
    /*      View      */
    /* ****************** */

    function getLastTradePrices() external view returns(uint[] memory lastTradePrices) {
        uint l = clearingHouse.getAmmsLength();
        lastTradePrices = new uint[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            lastTradePrices[i] = amm.lastPrice();
        }
    }

    function verifySigner(Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);

        // OB_SINT: Signer Is Not Trader
        require(signer == order.trader, "OB_SINT");

        return (signer, orderHash);
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /**
    * @notice Get the margin required to place an order
    * @dev includes trade fee (taker fee)
    */
    function getRequiredMargin(int256 baseAssetQuantity, uint256 price) public view returns(uint256 requiredMargin) {
        uint quoteAsset = abs(baseAssetQuantity).toUint256() * price / 1e18;
        requiredMargin = quoteAsset * minAllowableMargin / 1e6;
        requiredMargin += quoteAsset * takerFee / 1e6;
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _updateOrder(Order memory order, bytes32 orderHash, int256 fillAmount) internal {
        orderInfo[orderHash].filledAmount += fillAmount;
        require(abs(orderInfo[orderHash].filledAmount) <= abs(order.baseAssetQuantity), "OB_filled_amount_higher_than_order_base");

        // update order status if filled and free up reserved margin
        if (order.reduceOnly) {
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
                uint utilisedMargin = uint(abs(fillAmount)) * reservedMargin / uint(abs(order.baseAssetQuantity));
                orderInfo[orderHash].reservedMargin -= utilisedMargin;
                marginAccount.releaseMargin(order.trader, utilisedMargin);
            }
        }
    }

    /**
    * @notice deletes everything except status and filledAmount from orderInfo
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
    * @notice returns true if x is multiple of y and abs(x) >= y
    * @dev assumes y is positive
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }

    function parseMatchingError(string memory err) pure public returns(bytes32 orderHash, string memory reason) {
        (orderHash, reason) = abi.decode(bytes(err), (bytes32, string));
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function pause() external onlyGovernance {
        _pause();
    }

    function unpause() external onlyGovernance {
        _unpause();
    }

    function setValidatorStatus(address validator, bool status) external onlyGovernance {
        isValidator[validator] = status;
    }

    function initializeMinSize(int minSize) external onlyGovernance {
        minSizes.push(minSize);
    }

    function updateMinSize(uint ammIndex, int minSize) external onlyGovernance {
        minSizes[ammIndex] = minSize;
    }

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }

    function updateParams(uint _minAllowableMargin, uint _takerFee) external {
        require(msg.sender == address(clearingHouse), "OB_only_clearingHouse");
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
    }

    function setUseNewPricingAlgorithm(bool useNew) external onlyGovernance {
        if (useNew) {
            useNewPricingAlgorithm = 1;
        }
        useNewPricingAlgorithm = 0;
    }
}
