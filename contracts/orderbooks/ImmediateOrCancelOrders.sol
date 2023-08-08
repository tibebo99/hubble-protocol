// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";

import { Governable, VanillaGovernable } from "../legos/Governable.sol";
import { IOrderHandler } from "./IOrderHandler.sol";
import { IJuror } from "../precompiles/Juror.sol";
import { IHubbleReferral } from "../HubbleReferral.sol";

interface IImmediateOrCancelOrders is IOrderHandler {
    struct Order {
        uint8 orderType;
        uint256 expireAt;
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
        OrderStatus status;
    }

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, Order order, uint timestamp);

    /**
     * @notice Send signed orders as part of this tx. Even a relayer can use this method to aggregate and send orders for a large number of users
     * @dev This is just a broadcast mechanism. These do not perform any state change. Just emit an event to notify clients that some orders have been broadcasted.
    */
    function placeOrders(Order[] calldata orders) external;
    function orderStatus(bytes32 orderHash) external view returns (OrderInfo memory);
    function expirationCap() external view returns (uint);
    function getOrderHash(IImmediateOrCancelOrders.Order memory order) external view returns (bytes32);
}

/**
 * @title Send signed orders as transaction payload. Validations only happen at the time of matching.
*/
contract ImmediateOrCancelOrders is IImmediateOrCancelOrders, VanillaGovernable, Pausable, EIP712Upgradeable {

    mapping(bytes32 => OrderInfo) internal _orderStatus; // SLOT_53 !!! used in precompile !!!
    uint public expirationCap; // SLOT_54 !!! used in precompile !!!
    address public defaultOrderBook;
    IJuror public juror;
    address public referral;

    uint256[49] private __gap;

    modifier onlyDefaultOrderBook() {
        require(msg.sender == defaultOrderBook, "only default orderBook");
        _;
    }

    function initialize(
        address _governance,
        address _defaultOrderBook,
        address _juror
    ) external initializer {
        __EIP712_init("Hubble", "2.0");
        _setGovernace(_governance);
        defaultOrderBook = _defaultOrderBook;
        juror = IJuror(_juror);
        expirationCap = 20; // seconds
    }

    /**
     * @inheritdoc IImmediateOrCancelOrders
    */
    function placeOrders(Order[] calldata orders) override external {
        bytes32[] memory orderHashes = juror.validatePlaceIOCOrders(orders, _msgSender());
        for (uint i = 0; i < orderHashes.length; i++) {
            _orderStatus[orderHashes[i]] = OrderInfo(block.number, 0, OrderStatus.Placed);
            emit OrderPlaced(orders[i].trader, orderHashes[i], orders[i], block.timestamp);
        }
    }

    function updateOrder(bytes calldata encodedOrder, bytes calldata metadata) external onlyDefaultOrderBook {
        (bytes32 orderHash, int256 fillAmount) = abi.decode(metadata, (bytes32, int256));
        _orderStatus[orderHash].filledAmount += fillAmount;
        Order memory order = abi.decode(encodedOrder, (Order));
        if (_orderStatus[orderHash].filledAmount == order.baseAssetQuantity) {
            _orderStatus[orderHash].status = OrderStatus.Filled;
        }
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function orderStatus(bytes32 orderHash) override external view returns (OrderInfo memory) {
        return _orderStatus[orderHash];
    }

    function getOrderHash(IImmediateOrCancelOrders.Order memory order) external view returns (bytes32) {
        bytes32 ORDER_TYPEHASH = keccak256("IOCOrder(uint8 orderType,uint256 expireAt,uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setExpirationCap(uint _expirationCap) external onlyGovernance {
        expirationCap = _expirationCap;
    }

    function setJuror(address _juror) external onlyGovernance {
        juror = IJuror(_juror);
    }

    function setReferral(address _referral) external onlyGovernance {
        referral = _referral;
    }
}
