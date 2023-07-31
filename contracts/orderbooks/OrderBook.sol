// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IOrderHandler } from "./IOrderHandler.sol";
import { ILimitOrderBook, LimitOrderBook } from "./LimitOrderBook.sol";
import { IClearingHouse, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IJuror } from "../precompiles/Juror.sol";

interface IOrderBook is ILimitOrderBook {
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatched(address indexed trader, bytes32 indexed orderHash, uint256 fillAmount, uint price, uint openInterestNotional, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatchingError(bytes32 indexed orderHash, string err);
    event LiquidationError(address indexed trader, bytes32 indexed orderHash, string err, uint256 toLiquidate);

    event TradingAuthorityWhitelisted(address indexed trader, address indexed authority);
    event TradingAuthorityRevoked(address indexed trader, address indexed authority);

    /**
     * @notice Execute a long and a short order that match each other.
     * Can only be called by a validator.
     * @param orders orders[0] is the long order and orders[1] is the short order
     * @param fillAmount Amount of base asset to be traded between the two orders. Should be +ve. Scaled by 1e18
    */
    function executeMatchedOrders(bytes[2] calldata orders, int256 fillAmount) external;

    /**
     * @notice Liquidate a trader's position by matching it with a corresponding order
     * @param trader Address of the trader to be liquidated
     * @param order order to execute the liquidation with
     * When liquidating a short position, the liquidation order should be a short order
     * When liquidating a long position, the liquidation order should be a long order
     * @param toLiquidate Amount of base asset to be liquidated. Should be +ve no matter the direction of the position. Scaled by 1e18
    */
    function liquidateAndExecuteOrder(address trader, bytes calldata order, uint256 toLiquidate) external;

    function settleFunding() external;
    function initializeMinSize(int256 minSize) external;
    function updateParams(uint minAllowableMargin, uint takerFee) external;

    /**
     * @notice Whitelist a trading authority call routed via referral contract
    */
    function setTradingAuthority(address trader, address authority) payable external;
}

/**
 * @title Order matching and liquidations.
 *        Mostly has only first level checks about validatiy of orders. More deeper checks and interactions happen in ClearingHouse.
 * @notice This contract is used by validators to relay matched/liquidation orders
 * @dev At several places we are using something called a `juror`. This is a special contract (precompile) that is deployed at a specific address.
 * But there is identical code in this contract that can be used as a fallback if the precompile is not available.
*/
contract OrderBook is IOrderBook, LimitOrderBook {
    using SafeCast for int256;

    // for backwards compatibility with orderbook contract on hubblenext, only introduce new variables in LimitOrderBook

    constructor(address _clearingHouse, address _marginAccount) LimitOrderBook(_clearingHouse, _marginAccount) {}

    /* ****************** */
    /*    Match Orders    */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function executeMatchedOrders(
        bytes[2] calldata data,
        int256 fillAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        (
            IClearingHouse.Instruction[2] memory instructions,
            uint8[2] memory orderTypes,
            bytes[2] memory encodedOrders,
            uint fillPrice
        ) = juror.validateOrdersAndDetermineFillPrice(data, fillAmount);
        try clearingHouse.openComplementaryPositions(instructions, fillAmount, fillPrice) returns (uint256 openInterestNotional) {
            _updateOrder(orderTypes[0], encodedOrders[0], abi.encode(instructions[0].orderHash, fillAmount));
            _updateOrder(orderTypes[1], encodedOrders[1], abi.encode(instructions[1].orderHash, -fillAmount));
            uint fillAmountUint = fillAmount.toUint256();
            emit OrdersMatched(
                instructions[0].orderHash,
                instructions[1].orderHash,
                fillAmountUint,
                fillPrice,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
            emit OrderMatched(instructions[0].trader, instructions[0].orderHash, fillAmountUint, fillPrice, openInterestNotional, block.timestamp);
            emit OrderMatched(instructions[1].trader, instructions[1].orderHash, fillAmountUint, fillPrice, openInterestNotional, block.timestamp);
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 orderHash, string memory reason) {
                emit OrderMatchingError(orderHash, reason);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        }
        /* catch (bytes memory err) {
            we do not any special handling for other generic type errors
            they can revert the entire tx as usual
        } */
    }

    /* ****************** */
    /*    Liquidation     */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function liquidateAndExecuteOrder(
        address trader,
        bytes calldata data,
        uint256 liquidationAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        (
            IClearingHouse.Instruction memory instruction,
            uint8 orderType,
            bytes memory encodedOrder,
            uint fillPrice,
            int256 fillAmount // signed depending on the direction of the order. -ve if short order, +ve if long order is being fulfilled
        ) = juror.validateLiquidationOrderAndDetermineFillPrice(data, liquidationAmount);
        try clearingHouse.liquidate(instruction, fillAmount, fillPrice, trader) returns (uint256 openInterestNotional) {
            _updateOrder(orderType, encodedOrder, abi.encode(instruction.orderHash, fillAmount));
            emit LiquidationOrderMatched(
                trader,
                instruction.orderHash,
                liquidationAmount,
                fillPrice,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
            emit OrderMatched(instruction.trader, instruction.orderHash, liquidationAmount, fillPrice, openInterestNotional, block.timestamp);
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 _orderHash, string memory reason) {
                if (instruction.orderHash == _orderHash) { // err in openPosition for the order
                    emit OrderMatchingError(_orderHash, reason);
                    reason = "OrderMatchingError";
                } // else err in liquidating the trader; but we emit this either ways so that we can track liquidation didnt succeed for whatever reason
                emit LiquidationError(trader, _orderHash, reason, liquidationAmount);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        }
        /* catch (bytes memory err) {
            we do not any special handling for other generic type errors
            they can revert the entire tx as usual
        } */
    }

    /* ****************** */
    /*  Funding Payments  */
    /* ****************** */

    function settleFunding() external {
        clearingHouse.settleFunding();
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _updateOrder(uint8 orderType, bytes memory encodedOrder, bytes memory metadata) internal {
        address handler = orderType == 0 ? address(this) : orderHandlers[orderType];
        require(handler != address(0), "OrderBook: invalid order handler");
        IOrderHandler(handler).updateOrder(encodedOrder, metadata);
    }

    /* ****************** */
    /*  Trading Authority */
    /* ****************** */

    /**
     * @notice Whitelist a trading authority to be able to place orders on behalf of the caller and optionally transfer some gas token to the authority
    */
    function whitelistTradingAuthority(address authority) payable external {
        _whitelistTradingAuthority(_msgSender(), authority, msg.value);
    }

    /**
     * @inheritdoc IOrderBook
    */
    function setTradingAuthority(address trader, address authority) payable external {
        require(msg.sender == referral, "no auth");
        _whitelistTradingAuthority(trader, authority, msg.value);
    }

    function _whitelistTradingAuthority(address trader, address authority, uint airdrop) internal {
        require(trader != address(0) && authority != address(0), "null address");
        isTradingAuthority[trader][authority] = true;
        emit TradingAuthorityWhitelisted(trader, authority);
        if (airdrop != 0) {
            (bool success, ) = payable(authority).call{value: airdrop}("");
            require(success, "OrderBook: failed to airdrop gas to authority");
        }
    }

    /**
     * @notice Revoke trading authority of an address
    */
    function revokeTradingAuthority(address authority) external {
        address trader = _msgSender();
        isTradingAuthority[trader][authority] = false;
        emit TradingAuthorityRevoked(trader, authority);
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function parseMatchingError(string memory err) pure public returns(bytes32 orderHash, string memory reason) {
        (orderHash, reason) = abi.decode(bytes(err), (bytes32, string));
    }

    /* ****************** */
    /*   Config Updates   */
    /* ****************** */

    function initializeMinSize(int minSize) external onlyGovernance {
        minSizes.push(minSize);
    }

    function updateMinSize(uint ammIndex, int minSize) external onlyGovernance {
        minSizes[ammIndex] = minSize;
    }

    function updateParams(uint _minAllowableMargin, uint _takerFee) external onlyClearingHouse {
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
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

    function setJuror(address _juror) external onlyGovernance {
        juror = IJuror(_juror);
    }

    function setOrderHandler(uint8 orderType, address handler) external onlyGovernance {
        orderHandlers[orderType] = handler;
    }
}
