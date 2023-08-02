// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { AggregatorV3Interface } from "./Interfaces.sol";
import { IOracle } from "./Interfaces.sol";

contract NewOracle is IOracle, VanillaGovernable {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct ChainlinkAggregator {
        address aggregator;
        uint256 heartbeat; // max threshold for the aggregator to be considered stale
    }

    mapping(address => ChainlinkAggregator) public chainLinkAggregatorMap;
    mapping(address => int256) public stablePrice;

    constructor() {
        _setGovernace(msg.sender);
    }

    function getUnderlyingPrice(address underlying)
        virtual
        external
        view
        returns(int256 answer)
    {
        if (stablePrice[underlying] != 0) {
            return stablePrice[underlying];
        }
        uint updatedAt;
        (,answer,, updatedAt,) = AggregatorV3Interface(chainLinkAggregatorMap[underlying].aggregator).latestRoundData();
        require(answer > 0, "Oracle.getUnderlyingPrice.non_positive");
        require(_blockTimestamp() - updatedAt <= chainLinkAggregatorMap[underlying].heartbeat, "Oracle.getUnderlyingPrice.stale");
        answer /= 100;
    }

    function getUnderlyingTwapPrice(address underlying, uint256 periodStart, uint256 intervalInSeconds)
        virtual
        public
        view
        returns (int256)
    {
        if (stablePrice[underlying] != 0) {
            return stablePrice[underlying];
        }
        AggregatorV3Interface aggregator = AggregatorV3Interface(chainLinkAggregatorMap[underlying].aggregator);
        requireNonEmptyAddress(address(aggregator));
        require(intervalInSeconds != 0, "interval can't be 0");

        // 3 different timestamps, `previous`, `current`, `target`
        // `base` = now - intervalInSeconds
        // `current` = current round timestamp from aggregator
        // `previous` = previous round timestamp from aggregator
        // now >= previous > current > = < base
        //
        //  while loop i = 0
        //  --+------+-----+-----+-----+-----+-----+
        //         base                 current  now(previous)
        //
        //  while loop i = 1
        //  --+------+-----+-----+-----+-----+-----+
        //         base           current previous now

        (uint80 round, uint256 latestPrice, uint256 latestTimestamp) = getLatestRoundData(aggregator, underlying);
        // if latest updated timestamp is earlier than target timestamp, return the latest price.
        if (latestTimestamp <= periodStart || round == 0) {
            return _formatPrice(latestPrice);
        }

        // if latest updated timestamp is later than current hour start, iterate till we find round with timestamp earlier than current hour start
        // note this will increase gas cost when funding is delayed for a long time in current hour
        uint periodEnd = periodStart + intervalInSeconds;
        while(latestTimestamp > periodEnd) {
            round = round - 1;
            (, latestPrice, latestTimestamp) = getRoundData(aggregator, round);
        }

        // rounds are like snapshots, latestRound means the latest price snapshot. follow chainlink naming
        uint256 previousTimestamp = latestTimestamp;
        uint256 cumulativeTime = periodEnd - previousTimestamp;
        uint256 weightedPrice = latestPrice * cumulativeTime;
        while (true) {
            if (round == 0) {
                // if cumulative time is less than requested interval, return current twap price
                return _formatPrice(weightedPrice / cumulativeTime);
            }

            round = round - 1; // check round sanity
            (, uint256 currentPrice, uint256 currentTimestamp) = getRoundData(aggregator, round);

            // check if current round timestamp is earlier than target timestamp
            if (currentTimestamp <= periodStart) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, intervalInSeconds is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice + (currentPrice * (previousTimestamp - periodStart));
                break;
            }

            uint256 timeFraction = previousTimestamp - currentTimestamp;
            weightedPrice = weightedPrice + (currentPrice * timeFraction);
            cumulativeTime = cumulativeTime + timeFraction;
            previousTimestamp = currentTimestamp;
        }
        return _formatPrice(weightedPrice / intervalInSeconds);
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function getLatestRoundData(AggregatorV3Interface _aggregator, address underlying)
        internal
        view
        returns (
            uint80,
            uint256 finalPrice,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.latestRoundData();
        require(_blockTimestamp() - latestTimestamp <= chainLinkAggregatorMap[underlying].heartbeat, "Oracle.getLatestRoundData.stale");
        finalPrice = uint256(latestPrice);
        if (latestPrice <= 0) {
            requireEnoughHistory(round);
            (round, finalPrice, latestTimestamp) = getRoundData(_aggregator, round - 1);
        }
        return (round, finalPrice, latestTimestamp);
    }

    function getRoundData(AggregatorV3Interface _aggregator, uint80 _round)
        internal
        view
        returns (
            uint80,
            uint256,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.getRoundData(_round);
        while (latestPrice <= 0) {
            requireEnoughHistory(round);
            round = round - 1;
            (, latestPrice, , latestTimestamp, ) = _aggregator.getRoundData(round);
        }
        return (round, uint256(latestPrice), latestTimestamp);
    }

    function _formatPrice(uint256 _price) internal pure returns (int256) {
        return (_price / 100).toInt256(); // 6 decimals
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    // Internal

    function requireEnoughHistory(uint80 _round) internal pure {
        require(_round > 0, "Not enough history");
    }

    function requireNonEmptyAddress(address _addr) internal pure {
        require(_addr != address(0), "empty address");
    }

    // Governance

    function setAggregator(address underlying, address aggregator, uint hearbeat) external onlyGovernance {
        requireNonEmptyAddress(underlying);
        requireNonEmptyAddress(aggregator);
        // oracle answer should be in 8 decimals
        require(AggregatorV3Interface(aggregator).decimals() == 8, 'Expected oracle to have 8 decimals');
        chainLinkAggregatorMap[underlying] = ChainlinkAggregator(aggregator, hearbeat);
        // AggregatorV3Interface(chainLinkAggregatorMap[underlying]).latestRoundData(); // sanity check
    }

    /**
     * @dev setting the price to 0 will mean going to the oracle (chainLinkAggregatorMap[underlying]) for the price
     * @param price has to be scaled 1e6
    */
    function setStablePrice(address underlying, uint256 price) external onlyGovernance {
        requireNonEmptyAddress(underlying);
        if (price == 0) {
            requireNonEmptyAddress(chainLinkAggregatorMap[underlying].aggregator);
        }
        stablePrice[underlying] = price.toInt256();
    }
}
