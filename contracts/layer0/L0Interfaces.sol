// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

interface IHGTRemote {
    event SendToChain(uint16 indexed _dstChainId, uint256 indexed _nonce, bytes _lzPayload);
    event StargateDepositProcessed(uint16 indexed srcChainId, uint256 indexed nonce, uint tokenIdx, uint amountLD, bytes payload);
    event DepositSecondHopFailure(uint16 _srcChainId, bytes _srcAddress, uint256 _nonce, bytes _payload, bytes _reason);
    event ReceiveFromHubbleNet(uint16 indexed _dstChainId, address indexed _to, uint _amount, uint256 _nonce);
    event DepositFees(uint256 amount, uint256 time);
    event FundsRescued(address indexed to, uint16 _srcChainId, bytes _srcAddress, uint256 _nonce, uint tokenIdx, uint amount);


    struct DepositVars {
        address to;
        uint tokenIdx; // index of the token to deposit in the margin account
        uint amount; // total usdc amount to be charged from the user. (amount - toGas) will be credited to the margin/insurance fund, precision same as of the token to be deposited
        uint toGas; // gas token to be deposited to the user's wallet, 1e6 precision
        bool isInsuranceFund; // determines whether the amount is to be credited to the insurance fund or the margin account
        address payable refundAddress;  // if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
        address zroPaymentAddress; // the address of the ZRO token holder who would pay for the transaction (future param)
        bytes adapterParams;
    }

    struct SupportedToken {
        address token;
        // these fields are used for multi-hop deposit/withdrawals
        address priceFeed; // if a token has a price feed, it can be used for 2 hop transfers
        uint collectedFee; // will accumulate because we charge L0 native fee in token being deposited
        uint srcPoolId; // stargate pool id for token on local chain
        uint decimals; // decimals of the token
    }

    struct StoredPayload {
        address dstAddress;
        uint amount;
        uint64 payloadLength;
        bytes32 payloadHash;
    }

    function nonblockingLzReceive(uint16 _srcChainId, bytes memory /* _srcAddress */, uint64 nonce, bytes memory payload) external;
}

interface IHGT {
    struct WithdrawVars {
        uint16 dstChainId;
        uint16 secondHopChainId; // chain id for the second hop, if any
        uint dstPoolId; // stargate usdc pool id on the secondHop chain
        address to;
        uint tokenIdx; // index of the token to be withdrawn from the margin account
        uint amount; // token amount to be withdrawn, precision same as of the token to be withdrawn
        uint amountMin; // minimum amount of USDC to be received on the destination chain, 1e6 precision (used only for 2 hop transfers)
        // amountMin = amount - stargate layer0 fee - stargate slippage
        address payable refundAddress;  // if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
        address zroPaymentAddress; // the address of the ZRO token holder who would pay for the transaction (future param)
        bytes adapterParams;
    }

    event SendToChain(uint16 indexed _dstChainId, address indexed _from, address indexed _toAddress, uint _tokenIdx,  uint _amount, uint256 _nonce);
    event ReceiveFromChain(uint16 indexed _srcChainId, address indexed _to, uint _tokenIdx, uint _amount, bytes _metadata, uint256 _nonce);

    function estimateSendFee(WithdrawVars memory vars) external view returns (uint,uint);
    function withdraw(WithdrawVars memory vars) external payable;
}

// StarBridge Interfaces

interface IStargateRouter {
    struct lzTxObj {
        uint256 dstGasForCall;
        uint256 dstNativeAmount;
        bytes dstNativeAddr;
    }

    function bridge() external view returns(address);
    function factory() external view returns(address);

    function addLiquidity(
        uint256 _poolId,
        uint256 _amountLD,
        address _to
    ) external;

    function swap(
        uint16 _dstChainId,
        uint256 _srcPoolId,
        uint256 _dstPoolId,
        address payable _refundAddress,
        uint256 _amountLD,
        uint256 _minAmountLD,
        lzTxObj memory _lzTxParams,
        bytes calldata _to,
        bytes calldata _payload
    ) external payable;

    function redeemRemote(
        uint16 _dstChainId,
        uint256 _srcPoolId,
        uint256 _dstPoolId,
        address payable _refundAddress,
        uint256 _amountLP,
        uint256 _minAmountLD,
        bytes calldata _to,
        lzTxObj memory _lzTxParams
    ) external payable;

    function instantRedeemLocal(
        uint16 _srcPoolId,
        uint256 _amountLP,
        address _to
    ) external returns (uint256);

    function redeemLocal(
        uint16 _dstChainId,
        uint256 _srcPoolId,
        uint256 _dstPoolId,
        address payable _refundAddress,
        uint256 _amountLP,
        bytes calldata _to,
        lzTxObj memory _lzTxParams
    ) external payable;

    function sendCredits(
        uint16 _dstChainId,
        uint256 _srcPoolId,
        uint256 _dstPoolId,
        address payable _refundAddress
    ) external payable;

    function quoteLayerZeroFee(
        uint16 _dstChainId,
        uint8 _functionType,
        bytes calldata _toAddress,
        bytes calldata _transferAndCallPayload,
        lzTxObj memory _lzTxParams
    ) external view returns (uint256, uint256);

    function clearCachedSwap(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        uint256 _nonce
    ) external;
}

interface IStargateFactory {
    function getPool(uint256 _poolId) external view returns (address);
}

interface IStargateReceiver {
    function sgReceive(
        uint16 _srcChainId,              // the remote chainId sending the tokens
        bytes memory _srcAddress,        // the remote Bridge address
        uint256 _nonce,
        address _token,                  // the token contract on the local chain
        uint256 amountLD,                // the qty of local _token contract tokens
        bytes memory payload
    ) external;
}

interface IStarGateBridge {
    function layerZeroEndpoint() external view returns(address);
    event SendMsg(uint8 msgType, uint64 nonce);
}

interface IStarGatePool {
    event Swap(
        uint16 chainId,
        uint256 dstPoolId,
        address from,
        uint256 amountSD,
        uint256 eqReward,
        uint256 eqFee,
        uint256 protocolFee,
        uint256 lpFee
    );
    event SendCredits(uint16 dstChainId, uint256 dstPoolId, uint256 credits, uint256 idealBalance);
}
