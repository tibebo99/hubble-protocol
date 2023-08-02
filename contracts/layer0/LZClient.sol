// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.9;

import { NonblockingLzApp } from "@layerzerolabs/solidity-examples/contracts/lzApp/NonblockingLzApp.sol";
import { IHGTRemote } from "./L0Interfaces.sol";

contract LZClient is NonblockingLzApp {
    uint16 public immutable hubbleL0ChainId; // L0 chain id
    IHGTRemote public immutable hgtRemote;

    modifier onlyHGTRemote() {
        require(msg.sender == address(hgtRemote), "Only HGT Remote");
        _;
    }

    /**
     * @dev _lzEndPoint is immutable var in NonblockingLzApp
    */
    constructor(address _lzEndPoint, address _hgtRemote, uint16 _hubbleL0ChainId, address _owner) NonblockingLzApp(_lzEndPoint) {
        _transferOwnership(_owner);
        hubbleL0ChainId = _hubbleL0ChainId;
        hgtRemote = IHGTRemote(_hgtRemote);
    }

    /* ****************** */
    /*      Deposits      */
    /* ****************** */

    function sendLzMsg(
        bytes memory lzPayload,
        address payable refundAddress,
        address zroPaymentAddress,
        bytes memory adapterParams
    ) payable external onlyHGTRemote returns(uint64 nonce) {
        _lzSend(hubbleL0ChainId, lzPayload, refundAddress, zroPaymentAddress, adapterParams, msg.value);
        return lzEndpoint.getOutboundNonce(hubbleL0ChainId, address(this));
    }

    /* ****************** */
    /*     Withdrawals    */
    /* ****************** */

    function _nonblockingLzReceive(uint16 _srcChainId, bytes memory _srcAddress, uint64 nonce, bytes memory payload) internal override {
        hgtRemote.nonblockingLzReceive(_srcChainId, _srcAddress, nonce, payload);
    }

    function verifyAndClearFailedMessage(uint16 _srcChainId, bytes memory _srcAddress, uint64 _nonce, bytes calldata _payload) external onlyHGTRemote {
        bytes32 payloadHash = failedMessages[_srcChainId][_srcAddress][_nonce];
        require(payloadHash != bytes32(0), "LZClient: no stored message");
        require(keccak256(_payload) == payloadHash, "LZClient: invalid payload");
        // clear the stored message
        failedMessages[_srcChainId][_srcAddress][_nonce] = bytes32(0);
        emit RetryMessageSuccess(_srcChainId, _srcAddress, _nonce, payloadHash);
    }
}
