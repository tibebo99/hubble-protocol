// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRegistry {
    function oracle() external view returns(address);
    function clearingHouse() external view returns(address);
    function vusd() external view returns(address);
    function insuranceFund() external view returns(address);
    function marginAccount() external view returns(address);
    function orderBook() external view returns(address);
    function marginAccountHelper() external view returns(address);
}

interface IOracle {
    function getUnderlyingPrice(address asset) external view returns(int256);
    function getUnderlyingTwapPrice(address asset, uint256 startTimestamp, uint256 intervalInSeconds) external view returns (int256);
}

interface IClearingHouse {
    enum OrderExecutionMode {
        Taker,
        Maker,
        SameBlock, // not used
        Liquidation
    }

    /**
     * @param ammIndex Market id to place the order. In Hubble, market ids are sequential and start from 0
     * @param trader Address of the trader
     * @param mode Whether to be executed as a Maker, Taker or Liquidation
    */
    struct Instruction {
        uint256 ammIndex;
        address trader;
        bytes32 orderHash;
        OrderExecutionMode mode;
    }

    enum Mode { Maintenance_Margin, Min_Allowable_Margin }

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAsset, uint price, int256 realizedPnl, int256 size, uint256 openNotional, int256 fee, OrderExecutionMode mode, uint256 timestamp);
    event PositionLiquidated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 price, int256 realizedPnl, int256 size, uint256 openNotional, int256 fee, uint256 timestamp);
    event MarketAdded(uint indexed idx, address indexed amm);
    event ReferralBonusAdded(address indexed referrer, uint referralBonus);
    event FundingPaid(address indexed trader, uint indexed idx, int256 takerFundingPayment, int256 cumulativePremiumFraction);
    event FundingRateUpdated(uint indexed idx, int256 premiumFraction, uint256 underlyingPrice, int256 cumulativePremiumFraction, uint256 nextFundingTime, uint256 timestamp, uint256 blockNumber);

    function openComplementaryPositions(
        Instruction[2] memory orders,
        int256 fillAmount,
        uint fulfillPrice
    )  external returns (uint256 openInterest);

    function settleFunding() external;
    function getTotalNotionalPositionAndUnrealizedPnl(address trader, int256 margin, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl);
    function isAboveMaintenanceMargin(address trader) external view returns(bool);
    function assertMarginRequirement(address trader) external view;
    function updatePositions(address trader) external;
    function getTotalFunding(address trader) external view returns(int256 totalFunding);
    function getAmmsLength() external view returns(uint);
    function amms(uint idx) external view returns(IAMM);
    function maintenanceMargin() external view returns(int256);
    function minAllowableMargin() external view returns(int256);
    function takerFee() external view returns(int256);
    function makerFee() external view returns(int256);
    function liquidationPenalty() external view returns(uint256);
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);
    function getNotionalPositionAndMarginVanilla(address trader, bool includeFundingPayments, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);
    function liquidate(
        Instruction calldata instruction,
        int256 liquidationAmount,
        uint price,
        address trader
    ) external returns (uint256 openInterest);
    function feeSink() external view returns(address);
    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) external view returns(int256);
    function getUnderlyingPrice() external view returns(uint[] memory prices);
    function orderBook() external view returns(address);
    function getAMMs() external view returns (IAMM[] memory);
}

interface ERC20Detailed {
    function decimals() external view returns (uint8);
}

interface IMarginAccountHelper {
    function addVUSDMarginWithReserve(uint256 amount, address to) external payable;
    function removeMarginInUSD(uint256 amount) external;
    function depositToInsuranceFund(uint256 amount, address to) external payable;
    function withdrawFromInsuranceFund(uint256 shares) external;
    function marginAccount() external view returns(address);
}

interface IInsuranceFund {
    function seizeBadDebt(uint amount) external;
    function startAuction(address token) external;
    function calcVusdAmountForAuction(address token, uint amount) external view returns(uint);
    function buyCollateralFromAuction(address token, uint amount) external;
    function depositFor(address to, uint amount) external;
    function withdrawFor(address to, uint shares) external returns(uint);
}

interface IAMM {
    function openPosition(address trader, int256 fillAmount, uint256 fulfillPrice, bool is2ndTrade)
        external
        returns (int realizedPnl, bool isPositionIncreased, int size, uint openNotional, uint openInterest);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl);
    function updatePosition(address trader) external returns(int256 fundingPayment, int256 cumulativePremiumFraction);
    function liquidatePosition(address trader, uint price, int fillAmount) external returns (int realizedPnl, uint quoteAsset, int size, uint openNotional);
    function settleFunding() external returns (int256 premiumFraction, int256 underlyingPrice, int256 /* cumulativePremiumFraction */, uint256 /* nextFundingTime */);
    function underlyingAsset() external view returns (address);
    function positions(address trader) external view returns (int256,uint256,int256,uint256);
    function getPendingFundingPayment(address trader)
        external
        view
        returns(
            int256 takerFundingPayment,
            int256 latestCumulativePremiumFraction
        );
    function getOpenNotionalWhileReducingPosition(int256 positionSize, uint256 notionalPosition, int256 unrealizedPnl, int256 baseAssetQuantity)
        external
        pure
        returns(uint256 remainOpenNotional, int realizedPnl);
    function getOptimalPnl(address trader, int256 margin, IClearingHouse.Mode mode) external view returns (uint, int256);
    function lastPrice() external view returns(uint256);
    function startFunding() external returns(uint256);
    function openInterestNotional() external view returns(uint256);
    function getUnderlyingPrice() external view returns(uint256);
    function minSizeRequirement() external view returns(uint256);
    function maxOracleSpreadRatio() external view returns(uint256);
    function maxLiquidationPriceSpread() external view returns(uint256);
    function oracle() external view returns(IOracle);
}

// for backward compatibility in forked tests
interface IAMM_old is IAMM {
    function setMaxOracleSpreadRatio(uint) external;
}

interface IMarginAccount {
    struct Collateral {
        IERC20 token;
        uint weight;
        uint8 decimals;
    }

    enum LiquidationStatus {
        IS_LIQUIDATABLE,
        OPEN_POSITIONS,
        NO_DEBT,
        ABOVE_THRESHOLD
    }

    /* ****************** */
    /*       Events       */
    /* ****************** */

    /// @notice Emitted when user adds margin for any of the supported collaterals
    event MarginAdded(address indexed trader, uint256 indexed idx, uint amount, uint256 timestamp);

    /// @notice Emitted when user removes margin for any of the supported collaterals
    event MarginRemoved(address indexed trader, uint256 indexed idx, uint256 amount, uint256 timestamp);

    /**
    * @notice Mutates trader's vUSD balance
    * @param trader Account who is realizing PnL
    * @param realizedPnl Increase or decrease trader's vUSD balace by. +ve/-ve value means vUSD is added/removed respectively from trader's margin
    */
    event PnLRealized(address indexed trader, int256 realizedPnl, uint256 timestamp);

    /**
    * @notice Emitted when a trader's margin account is liquidated i.e. their vUSD debt is repayed in exchange for their collateral
    * @param trader Trader whose margin account was liquidated
    * @param idx Index of the collateral that was seized during the liquidation
    * @param seizeAmount Amount of the collateral that was seized during the liquidation
    * @param repayAmount The debt that was repayed
    */
    event MarginAccountLiquidated(address indexed trader, uint indexed idx, uint seizeAmount, uint repayAmount, uint256 timestamp);
    event MarginReserved(address indexed trader, uint amount);
    event MarginReleased(address indexed trader, uint amount);

    /**
    * @notice Emitted when funds from insurance fund are tasked to settle system's bad debt
    * @param trader Account for which the bad debt was settled
    * @param seized Collateral amounts that were seized
    * @param repayAmount Debt that was settled. it's exactly equal to -vUSD when vUSD < 0
    */
    event SettledBadDebt(address indexed trader, uint[] seized, uint repayAmount, uint256 timestamp);

    function addMargin(uint idx, uint amount) external;
    function addMarginFor(uint idx, uint amount, address to) external;
    function removeMargin(uint idx, uint256 amount) external;
    function removeMarginFor(uint idx, uint256 amount, address trader) external;
    function getSpotCollateralValue(address trader) external view returns(int256 spot);
    function weightedAndSpotCollateral(address trader) external view returns(int256, int256);
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
    function isLiquidatable(address trader, bool includeFunding) external view returns(LiquidationStatus, uint, uint);
    function supportedAssetsLen() external view returns(uint);
    function supportedAssets() external view returns (Collateral[] memory);
    function margin(uint idx, address trader) external view returns(int256);
    function transferOutVusd(address recipient, uint amount) external;
    function liquidateExactRepay(address trader, uint repay, uint idx, uint minSeizeAmount) external;
    function oracle() external view returns(IOracle);
    function reserveMargin(address trader, uint amount) external;
    function releaseMargin(address trader, uint amount) external;
    function reservedMargin(address trader) external view returns(uint);
    function getAvailableMargin(address trader) external view returns (int availableMargin);
    function updateParams(uint _minAllowableMargin) external;
    function getCollateralToken(uint idx) external view returns (IERC20);
}

interface AggregatorV3Interface {

    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);

    // getRoundData and latestRoundData should both raise "No data present"
    // if they do not have data to report, instead of returning unset values
    // which could be misinterpreted as actual reported values.
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

interface IERC20FlexibleSupply is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

interface IVUSD {
    event WithdrawalFailed(address indexed trader, uint amount);

    function mintWithReserve(address to, uint amount) external payable;
    function withdraw(uint amount) external;
    function withdrawTo(address to, uint amount) external;
    function processWithdrawals() external;
}

interface IUSDC is IERC20FlexibleSupply {
    function masterMinter() external view returns(address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external;
}

interface IHubbleViewer {
    function clearingHouse() external returns(IClearingHouse);
    function marginAccount() external returns(IMarginAccount);
    function getQuote(int256 baseAssetQuantity, uint idx) external view returns(uint256 quoteAssetQuantity);
}

interface IWAVAX is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}
