// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.9;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { BytesLib } from "@layerzerolabs/solidity-examples/contracts/lzApp/NonblockingLzApp.sol";

import { IERC20, AggregatorV3Interface, ERC20Detailed } from "../Interfaces.sol";
import { IHGTRemote, IStargateReceiver, IStargateRouter } from "./L0Interfaces.sol";
import { LZClient } from "./LZClient.sol";
import { HubbleBase } from "../legos/HubbleBase.sol";

contract HGTRemote is IHGTRemote, IStargateReceiver, HubbleBase {
    using BytesLib for bytes;
    using SafeERC20 for IERC20;

    uint constant USDC_IDX = 0;
    uint constant PT_SEND = 1;
    uint constant BASE_PRECISION = 1e18;

    uint8 constant TYPE_SWAP_REMOTE = 1; // stargaet router swap function type
    IStargateRouter public stargateRouter;

    mapping(address => bool) public whitelistedRelayer;
    // failedMessages[srcChainId][srcAddress][nonce] = payloadHash
    mapping(uint16 => mapping(bytes => mapping(uint256 => bytes32))) public failedMessages;

    SupportedToken[] public supportedTokens;
    address public nativeTokenPriceFeed;
    LZClient public lzClient;

    uint256[50] private __gap;

    receive() external payable {
        emit DepositFees(msg.value, block.timestamp);
    }

    modifier checkWhiteList {
        require(whitelistedRelayer[msg.sender], "Not Valid Relayer");
        _;
    }

    modifier onlyMySelf() {
        require(msg.sender == address(this), "Only myself");
        _;
    }

    function initialize(address _governance, address _starGateRouter, SupportedToken calldata _usdc, address _nativeTokenPriceFeed) external initializer {
        _setGovernace(_governance);
        whitelistedRelayer[_starGateRouter] = true;
        stargateRouter = IStargateRouter(_starGateRouter);
        _addSupportedToken(_usdc);
        require(AggregatorV3Interface(_nativeTokenPriceFeed).decimals() == 8, "HGTRemote: Invalid price feed address");
        nativeTokenPriceFeed = _nativeTokenPriceFeed;
    }

    /* ****************** */
    /*      Deposits      */
    /* ****************** */

    /**
     * @notice Deposit supported coins directly from the main bridge
    */
    function deposit(DepositVars calldata vars) external payable whenNotPaused {
        bytes memory metadata = _validations(vars);
        address from = _msgSender();
        _debitFrom(from, vars.amount, vars.tokenIdx);
        _sendLzMsg(vars, metadata, msg.value);
    }

    function _validations(DepositVars memory vars) internal view returns (bytes memory metadata) {
        require(vars.amount != 0, "HGTRemote: Insufficient amount");
        require(vars.tokenIdx < supportedTokens.length, "HGTRemote: Invalid token index");
        if (vars.tokenIdx == USDC_IDX) {
            require(vars.amount >= vars.toGas, "HGTRemote: deposit < airdrop");
            metadata = abi.encode(vars.toGas, vars.isInsuranceFund);
        } else {
            require(vars.isInsuranceFund == false && vars.toGas == 0, "HGTRemote: Can transfer only usdc to insurance fund and gas wallet");
            // when we add new supported tokens, it will be possible to encode custom metadata for them, if required
        }
        // @todo do we need any validations on adapter params?
    }

    function _debitFrom(address from, uint amount, uint tokenIdx) internal {
        IERC20 token = IERC20(supportedTokens[tokenIdx].token);
        token.safeTransferFrom(from, address(this), amount);
    }

    function _buildLzPayload(DepositVars memory vars, bytes memory metadata) internal pure returns (bytes memory) {
        return abi.encode(PT_SEND, vars.to, vars.tokenIdx, vars.amount, metadata);
    }

    function _sendLzMsg(
        DepositVars memory vars,
        bytes memory metadata,
        uint _nativeFee
    ) internal {
        bytes memory lzPayload = _buildLzPayload(vars, metadata);
        uint64 nonce = lzClient.sendLzMsg{value: _nativeFee}(lzPayload, vars.refundAddress, vars.zroPaymentAddress, vars.adapterParams);
        emit SendToChain(lzClient.hubbleL0ChainId(), nonce, lzPayload);
    }

    /**
    * @notice This function will be called by stargate router after sending funds to this address
    * @param amountLD final amount of token received from stargate
    * layer0 fee is deducted from the amountLD to send it further to hubbleNet
    * there can be slippage in the amount transferred using stargate
    * @param payload payload received from stargate router
    * @param _token receiving token address
    * @dev stargate router address needs to be added as a whitelist relayer
    */
    function sgReceive(
        uint16 _srcChainId,
        bytes memory _srcAddress, // the remote Bridge address
        uint256 nonce,
        address _token, // the token contract on the local chain
        uint amountLD, // the qty of local _token contract tokens received
        bytes memory payload
    ) override external checkWhiteList {
        try this.processSgReceive(_srcChainId, nonce, _token, amountLD, payload) returns (uint tokenIdx, uint l0Fee) {
            supportedTokens[tokenIdx].collectedFee += l0Fee;
        } catch (bytes memory _reason) { // catches generic as well as revert/require errors
            bytes memory _payload = abi.encode(_token, amountLD, payload);
            failedMessages[_srcChainId][_srcAddress][nonce] = keccak256(_payload);
            emit DepositSecondHopFailure(_srcChainId, _srcAddress, nonce, _payload, _reason);
        }
    }

    function processSgReceive(
        uint16 _srcChainId,
        uint nonce,
        address _token,
        uint amountLD,
        bytes memory payload
    )
        public onlyMySelf returns (uint tokenIdx, uint l0Fee)
    {
        DepositVars memory vars = _decodeSgPayload(payload);
        vars.refundAddress = payable(address(this));
        vars.amount = amountLD;
        bytes memory metadata = _validations(vars);
        require(supportedTokens[vars.tokenIdx].token == _token, "HGTRemote: token mismatch");
        emit StargateDepositProcessed(_srcChainId, nonce, vars.tokenIdx, amountLD, payload);
        return _depositToHubblenet(vars, metadata);
    }

    function _depositToHubblenet(DepositVars memory vars, bytes memory metadata) internal returns (uint tokenIdx, uint l0Fee) {
        // _buildLzPayload() will need to be called again because actual deposit amount will change based on L0 fee
        // but we still construct this payload on a best-effort basis because the L0 fee will vary with payload length
        (uint nativeFee,) = lzClient.lzEndpoint().estimateFees(lzClient.hubbleL0ChainId(), address(lzClient), _buildLzPayload(vars, metadata), false /* _useZro */, vars.adapterParams);

        require(address(this).balance >= nativeFee, "HGTRemote: Insufficient native token balance");
        l0Fee = _verifyPriceAndFee(vars.tokenIdx, nativeFee, vars.amount);
        // The token (amountLD) is received, but we need to deduct the layer0 fee from it, which is paid in form of the native gas token
        // this problem only arises in multihop, because in single hop, it is sent as msg.value
        vars.amount -= l0Fee;

        if (vars.tokenIdx == USDC_IDX && vars.amount <= vars.toGas) {
            // if the remaining amount is less than the desired airdrop, then send the whole amount as gas airdrop
            vars.toGas = vars.amount;
            vars.isInsuranceFund = false; // redundant, but just to be sure
        }
        _sendLzMsg(vars, metadata, nativeFee);
        return (vars.tokenIdx, l0Fee);
    }

    function _decodeSgPayload(bytes memory payload) internal pure returns (DepositVars memory vars) {
        (
            vars.to, vars.tokenIdx, vars.amount, vars.toGas, vars.isInsuranceFund,
            vars.zroPaymentAddress, vars.adapterParams
        ) = abi.decode(payload, (address, uint, uint, uint, bool, address, bytes));
    }

    function retryDeposit(uint16 srcChainId,
        bytes memory srcAddress, // the remote Bridge address
        uint256 nonce,
        bytes memory _payload
    ) external {
        (address _token, uint amountLD, bytes memory payload) = _verifyAndClearFailedMessage(srcChainId, srcAddress, nonce, _payload);
        (uint tokenIdx, uint l0Fee) = this.processSgReceive(srcChainId, nonce, _token, amountLD, payload);
        supportedTokens[tokenIdx].collectedFee += l0Fee;
    }

    function _verifyAndClearFailedMessage(uint16 srcChainId, bytes memory srcAddress, uint256 nonce, bytes memory _payload) internal returns (address token, uint amountLD, bytes memory payload) {
        bytes32 payloadHash = failedMessages[srcChainId][srcAddress][nonce];
        require(payloadHash != bytes32(0), "HGTRemote: no stored message");
        require(keccak256(_payload) == payloadHash, "HGTRemote: invalid payload");
        // clear the stored message
        failedMessages[srcChainId][srcAddress][nonce] = bytes32(0);

        (token, amountLD, payload) = abi.decode(_payload, (address, uint, bytes));
    }

    function rescueDepositFunds(uint16 srcChainId, bytes memory srcAddress, uint256 nonce, bytes memory _payload) external {
        (address token, uint amountLD, bytes memory payload) = _verifyAndClearFailedMessage(srcChainId, srcAddress, nonce, _payload);
        DepositVars memory vars = _decodeSgPayload(payload);
        require(msg.sender == vars.to, "HGTRemote: sender must be receiver");
        // transfer funds to the user
        // Note that even if the token is not supported by this contract, it can still be recovered by the user
        IERC20(token).safeTransfer(vars.to, amountLD);
        emit FundsRescued(vars.to, srcChainId, srcAddress, nonce, vars.tokenIdx, amountLD);
    }

    /**
    * @notice returns native token and token[tokenIdx] price in 6 decimals
    */
    function _getTokenPrices(uint tokenIdx) internal view returns (int256 nativeTokenPrice, int256 tokenPrice) {
        nativeTokenPrice = getLatestRoundData(nativeTokenPriceFeed);
        tokenPrice = getLatestRoundData(supportedTokens[tokenIdx].priceFeed); // will revert for tokens that are not whitelisted for multi hops
    }

    /**
    * @notice returns layer0 fee coverted to token being transferred and its precision
    */
    function _calculateL0Fee(uint nativeFee, uint nativeTokenPrice, uint tokenPrice, uint tokenIdx) internal view returns (uint) {
        return nativeFee * nativeTokenPrice / tokenPrice / (10 ** (18 - supportedTokens[tokenIdx].decimals)); // nativeFee is 18 decimals, tokenPrice is 6 decimals
    }

    /* ****************** */
    /*     Withdrawals    */
    /* ****************** */

    function nonblockingLzReceive(uint16 _srcChainId, bytes memory /* _srcAddress */, uint64 nonce, bytes memory payload) external {
        require(msg.sender == address(lzClient), "HGTRemote: caller must be LZClient");
        (
            address to, uint tokenIdx, uint amount, uint16 secondHopChainId, uint amountMin, uint dstPoolId
        ) = _decodeAndVerifyLzPayload(payload);
        emit ReceiveFromHubbleNet(_srcChainId, to, amount, nonce);

        if (secondHopChainId == 0) {
            IERC20(supportedTokens[tokenIdx].token).safeTransfer(to, amount);
            return;
        }

        // It is called while withdrawing funds from hubbleNet to anyEVMChain (other than direct bridge chain)
        uint l0Fee = _teleportViaStargate(tokenIdx, amount, to, secondHopChainId, amountMin, dstPoolId, address(this));
        supportedTokens[tokenIdx].collectedFee += l0Fee;
    }

    function _decodeAndVerifyLzPayload(bytes memory payload) internal view returns (
        address to, uint tokenIdx, uint amount, uint16 secondHopChainId, uint amountMin, uint dstPoolId
    ) {
        uint16 packetType;
        (packetType, to, tokenIdx, amount, secondHopChainId, amountMin, dstPoolId) = abi.decode(payload, (uint16, address, uint, uint, uint16, uint, uint));
        require(tokenIdx < supportedTokens.length, "HGTRemote: Invalid token index");
        // check for amount and user, should not happen as we have already validated it in HGT
        require(amount != 0 && to != address(0x0), "HGTRemote: Insufficient amount or invalid user");
        require(packetType == PT_SEND, "HGTCore: unknown packet type");
    }

    struct Vars {
        uint nativeFee;
        bytes toAddress;
    }

    /**
    * @notice This function will be called when withdrawing funds from HubbleNet to remote chain to anyEvmChain
    * @dev stargate is used to transfer funds from remote chain to anyEvmChain
    * layer0 fee is deducted from the amount transferred to send it further to anyEvmChain
    */
    function _teleportViaStargate(uint tokenIdx, uint256 amount, address _to, uint16 _dstChainId, uint amountMin, uint _dstPoolId, address refundAddress) internal returns (uint l0Fee) {
        Vars memory vars;
        vars.toAddress = abi.encodePacked(_to);
        (vars.nativeFee, ) = stargateRouter.quoteLayerZeroFee(_dstChainId, TYPE_SWAP_REMOTE, vars.toAddress, new bytes(0), IStargateRouter.lzTxObj(0, 0, "0x"));
        l0Fee = _verifyPriceAndFee(tokenIdx, vars.nativeFee, amount);
        amount -= l0Fee;

        SupportedToken memory supportedToken = supportedTokens[tokenIdx];
        IERC20(supportedToken.token).safeApprove(address(stargateRouter), amount);
        stargateRouter.swap{value: vars.nativeFee}(
            _dstChainId,
            supportedToken.srcPoolId,
            _dstPoolId,
            payable(refundAddress),
            amount,
            amountMin,
            IStargateRouter.lzTxObj(0, 0, "0x"),
            vars.toAddress,
            bytes("")
        );
        // resetting allowance for safety
        IERC20(supportedToken.token).safeApprove(address(stargateRouter), 0);
    }

    function _verifyPriceAndFee(uint tokenIdx, uint nativeFee, uint amount) internal view returns (uint l0Fee) {
        (int nativeTokenPrice, int tokenPrice) = _getTokenPrices(tokenIdx);
        require(tokenPrice > 0 && nativeTokenPrice > 0, "HGTRemote: Negative Price");

        // since amountLD is in token being transferred precision, l0Fee being charged should also be in the same precision
        l0Fee = _calculateL0Fee(nativeFee, uint(nativeTokenPrice), uint(tokenPrice), tokenIdx);
        require(amount > l0Fee, "HGTRemote: Amount less than fee");
    }

    function rescueWithdrawFunds(uint16 srcChainId, bytes memory srcAddress, uint64 nonce, bytes memory payload) external {
        lzClient.verifyAndClearFailedMessage(srcChainId, srcAddress, nonce, payload);
        (
            address to, uint tokenIdx, uint amount,,,
        ) = _decodeAndVerifyLzPayload(payload);
        require(msg.sender == to, "HGTRemote: sender must be receiver");

        // transfer funds to the user
        IERC20(supportedTokens[tokenIdx].token).safeTransfer(to, amount);
        emit FundsRescued(to, srcChainId, srcAddress, nonce, tokenIdx, amount);
    }

    /* ****************** */
    /*       Common       */
    /* ****************** */

    function estimateSendFee(DepositVars memory vars) public view returns (uint,uint) {
        bytes memory metadata = _validations(vars);
        return lzClient.lzEndpoint().estimateFees(lzClient.hubbleL0ChainId(), address(lzClient), _buildLzPayload(vars, metadata), false /* _useZro */, vars.adapterParams);
    }

    function estimateSendFeeInUSD(DepositVars memory vars) external view returns (uint) {
        int256 latestPrice = getLatestRoundData(nativeTokenPriceFeed);
        if (latestPrice <= 0) return 0;
        (uint nativeFee,) = estimateSendFee(vars);
        return nativeFee * uint(latestPrice) / BASE_PRECISION;
    }

    function quoteStargateFeeInUSD(uint16 _dstChainId, uint8 _functionType, bytes calldata _toAddress,  bytes calldata _transferAndCallPayload, IStargateRouter.lzTxObj memory _lzTxParams) external view returns(uint) {
        int256 latestPrice = getLatestRoundData(nativeTokenPriceFeed);
        if (latestPrice <= 0) return 0;
        (uint nativeFee,) = stargateRouter.quoteLayerZeroFee(_dstChainId, _functionType, _toAddress, _transferAndCallPayload, _lzTxParams);
        return nativeFee * uint(latestPrice) / BASE_PRECISION;
    }

    function feeCollected(uint tokenIdx) external view returns (uint) {
        return supportedTokens[tokenIdx].collectedFee;
    }

    function getLatestRoundData(address priceFeed) internal view returns (int256 price) {
        (, price,,,) = AggregatorV3Interface(priceFeed).latestRoundData();
        return (price / 100);
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setWhitelistRelayer(address _whitelistRelayer, bool isWhiteList) external onlyGovernance {
        whitelistedRelayer[_whitelistRelayer] = isWhiteList;
    }

    function setStargateConfig(address _starGateRouter) external onlyGovernance {
        stargateRouter = IStargateRouter(_starGateRouter);
    }

    function addSupportedToken(SupportedToken calldata token) external onlyGovernance {
        _addSupportedToken(token);
    }

    function _addSupportedToken(SupportedToken memory token) internal {
        require(token.token != address(0x0), "HGTRemote: Invalid token address");
        require(token.collectedFee == 0, "HGTRemote: Invalid collected fee");
        if (token.priceFeed != address(0x0)) { // supported for multihops
            require(AggregatorV3Interface(token.priceFeed).decimals() == 8, "HGTRemote: Invalid price feed address");
            require(token.srcPoolId != 0, "HGTRemote: Invalid pool id");
        }
        token.decimals = ERC20Detailed(token.token).decimals(); // will revert if .decimals() is not defined in the contract
        supportedTokens.push(token);
    }

    function setLZClient(address _lzClient) external onlyGovernance {
        lzClient = LZClient(_lzClient);
    }

    // @todo add swap function to swap usdc to native token
}
