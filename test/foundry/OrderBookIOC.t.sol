// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract OrderBookIOCTests is Utils {
    RestrictedErc20 public weth;
    int public constant defaultWethPrice = 1000 * 1e6;
    uint public expirationCap;

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, IImmediateOrCancelOrders.Order order, uint timestamp);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatchingError(bytes32 indexed orderHash, string err);

    function setUp() public {
        setupContracts();
        // add collateral
        weth = setupRestrictedTestToken('Hubble Ether', 'WETH', 18);

        vm.startPrank(governance);
        orderBook.setValidatorStatus(address(this), true);
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice);
        marginAccount.whitelistCollateral(address(weth), 1e6);
        vm.stopPrank();
        expirationCap = iocOrderBook.expirationCap();
    }

    function testPlaceOrderIOC(uint128 traderKey, int size, uint price) public {
        vm.assume(
            traderKey != 0 &&
            stdMath.abs(size) >= uint(MIN_SIZE) &&
            size != type(int).min /** abs(size) fails */ &&
            price < type(uint).max / stdMath.abs(size) &&
            stdMath.abs(size) < type(uint).max / getUpperBound() &&
            price > 1e6
        );

        IImmediateOrCancelOrders.Order[] memory orders = new IImmediateOrCancelOrders.Order[](1);
        address trader;
        bytes32 orderHash;
        // place order with size < minSize
        (trader, orders[0], orderHash) = prepareIOCOrder(0, traderKey, MIN_SIZE - 1, price, false);

        vm.expectRevert("no trading authority");
        iocOrderBook.placeOrders(orders);

        vm.startPrank(trader);

        vm.expectRevert("not multiple");
        iocOrderBook.placeOrders(orders);

        size = (size / MIN_SIZE) * MIN_SIZE;
        // place order with size > minSize but not multiple of minSize
        (trader, orders[0], orderHash) = prepareIOCOrder(0, traderKey, size + 1234, price, false);

        vm.expectRevert("not multiple");
        iocOrderBook.placeOrders(orders);

        // revert if order type is not correct
        (trader, orders[0], orderHash) = prepareIOCOrder(0, traderKey, size, price, false);
        orders[0].orderType = 0;
        vm.expectRevert("not_ioc_order");
        iocOrderBook.placeOrders(orders);

        // revert if order expired
        orders[0].orderType = 1;
        orders[0].expireAt = block.timestamp - 1;
        vm.expectRevert("ioc expired");
        iocOrderBook.placeOrders(orders);

        // revert if order expiry is too high
        orders[0].expireAt = block.timestamp + expirationCap + 1;
        vm.expectRevert("ioc expiration too far");
        iocOrderBook.placeOrders(orders);

        orders = new IImmediateOrCancelOrders.Order[](2);
        bytes32[2] memory orderHashes;
        (trader, orders[0], orderHashes[0]) = prepareIOCOrder(0, traderKey, size, price, false);
        (trader, orders[1], orderHashes[1]) = prepareIOCOrder(0, traderKey, size, price + 1, false);

        orders[1].trader = address(0);
        vm.expectRevert('OB_trader_mismatch');
        iocOrderBook.placeOrders(orders);

        orders[1].trader = trader;
        vm.expectEmit(true, true, false, true, address(iocOrderBook));
        emit OrderPlaced(trader, orderHashes[0], orders[0], block.timestamp);
        emit OrderPlaced(trader, orderHashes[1], orders[1], block.timestamp);
        iocOrderBook.placeOrders(orders);

        vm.expectRevert("already exists");
        iocOrderBook.placeOrders(orders);

        vm.stopPrank();

        IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHashes[0]);
        assertEq(orderInfo.blockPlaced, block.number);
        assertEq(orders[0].expireAt, block.timestamp + expirationCap);
        assertEq(orderInfo.filledAmount, 0);
        assertEq(uint(orderInfo.status), 1); // placed

        orderInfo = iocOrderBook.orderStatus(orderHashes[1]);
        assertEq(orderInfo.blockPlaced, block.number);
        assertEq(orders[1].expireAt, block.timestamp + expirationCap);
        assertEq(orderInfo.filledAmount, 0);
        assertEq(uint(orderInfo.status), 1); // placed

        // order can be placed via trading authority
        orders[0].salt += 1;
        orders[1].salt += 1;
        orderHashes[0] = juror.getIOCOrderHash(orders[0]);
        orderHashes[1] = juror.getIOCOrderHash(orders[1]);
        // add trading authority
        vm.prank(trader);
        orderBook.whitelistTradingAuthority(address(this));
        assertTrue(orderBook.isTradingAuthority(trader, address(this)));

        vm.expectEmit(true, true, false, true, address(iocOrderBook));
        emit OrderPlaced(trader, orderHashes[0], orders[0], block.timestamp);
        emit OrderPlaced(trader, orderHashes[1], orders[1], block.timestamp);
        iocOrderBook.placeOrders(orders);

        // revoke trading authority
        vm.prank(trader);
        orderBook.revokeTradingAuthority(address(this));
        assertFalse(orderBook.isTradingAuthority(trader, address(this)));
    }

    function testExecuteMatchedOrdersIOC(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE + 2 * MIN_SIZE; // to avoid min size error

        IImmediateOrCancelOrders.Order[2] memory orders;
        bytes32[2] memory orderHashes;

        (orders[0], orderHashes[0]) = placeIOCOrder(0, aliceKey, size, price, false);
        (orders[1], orderHashes[1]) = placeIOCOrder(0, bobKey, -size, price, false);

        vm.expectRevert("overfill");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size + MIN_SIZE);

        vm.expectRevert("not multiple");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size - 1);

        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(orderHashes[0], "CH: Below Minimum Allowable Margin");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);

        IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHashes[0]);
        assertEq(orderInfo.blockPlaced, block.number);
        assertEq(orders[0].expireAt, block.timestamp + expirationCap);
        assertEq(orderInfo.filledAmount, size);
        assertEq(uint(orderInfo.status), 2); // filled

        orderInfo = iocOrderBook.orderStatus(orderHashes[1]);
        assertEq(orderInfo.blockPlaced, block.number);
        assertEq(orders[1].expireAt, block.timestamp + expirationCap);
        assertEq(orderInfo.filledAmount, -size);
        assertEq(uint(orderInfo.status), 2); // filled

        vm.expectRevert("invalid order");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);

        assertPositions(alice, size, quote, 0, quote * 1e18 / stdMath.abs(size));
        assertPositions(bob, -size, quote, 0, quote * 1e18 / stdMath.abs(size));
    }

    function testLiquidateAndExecuteOrderIOC(uint64 price, uint120 size_) public {
        vm.assume(price > 10 && size_ != 0);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // add weth margin
        temp[0] = orderBook.getRequiredMargin(size, price, getUpperBound()) * 1e18 / uint(defaultWethPrice) + 1e10; // required weth margin in 1e18, add 1e10 for any precision loss
        addMargin(alice, temp[0], 1, address(weth));
        temp[0] = orderBook.getRequiredMargin(-size, price, getUpperBound()) * 1e18 / uint(defaultWethPrice) + 1e10;
        addMargin(bob, temp[0], 1, address(weth));
        // order placed and executed as limit orders, type = 0
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        // make alice and bob in liquidatin zone
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 10);
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        address charlie;
        (charlie, temp[3] /** charlieKey */) = makeAddrAndKey("charlie");
        addMargin(charlie, stdMath.abs(size) * price / 1e18, 0, address(0));
        (IImmediateOrCancelOrders.Order memory order, bytes32 orderHash) = placeIOCOrder(0, temp[3], size, price, false);

        // liquidate alice
        uint toLiquidate;
        {
            (,,,uint liquidationThreshold) = amm.positions(alice);
            toLiquidate = Math.min(stdMath.abs(size), liquidationThreshold);
            toLiquidate = toLiquidate / uint(MIN_SIZE) * uint(MIN_SIZE);
        }

        vm.expectRevert("not multiple");
        orderBook.liquidateAndExecuteOrder(alice, encodeIOCOrder(order), toLiquidate + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit LiquidationOrderMatched(address(alice), orderHash, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.liquidateAndExecuteOrder(alice, encodeIOCOrder(order), toLiquidate);

        {
            IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHash);
            assertEq(uint(orderInfo.status), 1);
            assertEq(orderInfo.filledAmount, int(toLiquidate));
            assertEq(marginAccount.reservedMargin(charlie), 0);
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, alice), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + liquidationPenalty + tradeFee in liquidation
            assertEq(husd.balanceOf(feeSink), 2 * calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                uint(marginAccount.margin(0, charlie)) // charlie margin
                - liquidationPenalty - calculateTakerFee(size, price) // alice margin
                - calculateTakerFee(size, price) // bob margin
            );
        }

        // liquidate bob
        address peter;
        {
            (peter, temp[3] /** peterKey */) = makeAddrAndKey("peter");
            addMargin(peter, stdMath.abs(size) * price / 1e18, 0, address(0));
            (order, orderHash) = placeIOCOrder(0, temp[3], -size, price, true);
            // reduceOnly order will be reverted is size < reduceOnly size
            vm.expectRevert("not reducing pos");
            orderBook.liquidateAndExecuteOrder(bob, encodeIOCOrder(order), toLiquidate);
            (order, orderHash) = placeIOCOrder(0, temp[3], -size, price, false);
        }

        {
            vm.expectEmit(true, false, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(bob), orderHash, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
            orderBook.liquidateAndExecuteOrder(bob, encodeIOCOrder(order), toLiquidate);
        }
        {
            IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHash);
            assertEq(uint(orderInfo.status), 1);
            assertEq(orderInfo.filledAmount, -int(toLiquidate));
            assertEq(marginAccount.reservedMargin(peter), 0);
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, bob), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + 2 * (liquidationPenalty + tradeFee in liquidation)
            assertEq(husd.balanceOf(feeSink), 2 * (calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price)));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                2 * uint(marginAccount.margin(0, charlie)) // charlie + peter margin
                - 2 * (liquidationPenalty + calculateTakerFee(size, price)) // alice + bob margin
            );
        }
    }

    function testCannotExecuteMatchedOrdersIOC(uint120 price, uint120 size_) public {
        vm.assume(price > 20);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  MIN_SIZE; // to avoid min size error

        IImmediateOrCancelOrders.Order[2] memory orders;
        bytes32[2] memory orderHashes;

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0], orderHashes[0]) = placeIOCOrder(0, aliceKey, size, price, false);
        (orders[1], orderHashes[1]) = placeIOCOrder(0, bobKey, -size, price, false);

        vm.expectRevert("not long");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[1]), encodeIOCOrder(orders[0])], size);
        vm.expectRevert("not short");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[0])], size);
        vm.expectRevert("expecting positive fillAmount");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], 0);

        // revert if IOC order expired
        vm.warp(block.timestamp + 21);
        vm.expectRevert("ioc expired");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);

        // reduce long order price
        (orders[0], orderHashes[0]) = placeIOCOrder(0, aliceKey, size, price - 1, false);
        (orders[1], orderHashes[1]) = placeIOCOrder(0, bobKey, -size, price, false);
        vm.expectRevert("OB_orders_do_not_match");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);

        // match when all conditions met
        (orders[0], orderHashes[0]) = placeIOCOrder(0, aliceKey, size, price, false);
        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], size);
    }

    function testReduceOnlyIOC(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE +  10 * MIN_SIZE; // to avoid min size error

        // alice longs, bob shorts, fillAmount = size / 2
        int fillAmount = (size / 2) / MIN_SIZE * MIN_SIZE;
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, fillAmount, false);

        IImmediateOrCancelOrders.Order[] memory order = new IImmediateOrCancelOrders.Order[](1);
        bytes32 orderHash;

        // position cannot increase for a reduce-only order
        // long order increase fail, alice longs more
        (, order[0], orderHash) = prepareIOCOrder(0, aliceKey, size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_order_must_reduce_position');
        vm.prank(alice);
        iocOrderBook.placeOrders(order);
        // short order increase fail, bob shorts more
        (, order[0], orderHash) = prepareIOCOrder(0, bobKey, -size, price - 1, true /** reduceOnly */);
        vm.expectRevert('OB_reduce_only_order_must_reduce_position');
        vm.prank(bob);
        iocOrderBook.placeOrders(order);

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        // reduce only order placed but failed at execution
        IImmediateOrCancelOrders.Order[2] memory orders;
        bytes32[2] memory orderHashes;
        (orders[0], orderHashes[0]) = placeIOCOrder(0, bobKey, fillAmount, price - 2, true /** reduceOnly */);
        (orders[1], orderHashes[1]) = placeIOCOrder(0, aliceKey, -fillAmount, price - 2, true /** reduceOnly */);

        // decrease poistion size, alice shorts, bob longs
        int closeAmount = (fillAmount / 2) / MIN_SIZE * MIN_SIZE;
        placeAndExecuteOrder(0, bobKey, aliceKey, closeAmount, price, false, false, closeAmount, true);

        vm.expectRevert("not reducing pos");
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], fillAmount);

        // reduceOnly order can decrease position size
        orderBook.executeMatchedOrders([encodeIOCOrder(orders[0]), encodeIOCOrder(orders[1])], fillAmount - closeAmount);
        assertPositions(alice, 0, 0, 0, 0);
        assertPositions(bob, 0, 0, 0, 0);
    }

    function testCrossOrderMatching(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_)) / MIN_SIZE * MIN_SIZE + 2 * MIN_SIZE; // to avoid min size error

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (IImmediateOrCancelOrders.Order memory order0, bytes32 orderHash0) = placeIOCOrder(0, aliceKey, size, price, false);
        (ILimitOrderBook.Order memory order1,, bytes32 orderHash1) = placeOrder(0, bobKey, -size, price, false); // limit order

        // execute limit order as IOC order
        bytes memory badIOCOrder = abi.encode(1, abi.encode(order1));
        vm.expectRevert(); // reverts in abi.decode
        orderBook.executeMatchedOrders([encodeIOCOrder(order0), badIOCOrder], size);

        // execute IOC order as limit order
        bytes memory badLimitOrder = abi.encode(0, abi.encode(order0));
        vm.expectRevert(); // reverts in abi.decode
        orderBook.executeMatchedOrders([badLimitOrder, encodeLimitOrder(order1)], size);

        // cross order matched
        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHash0, orderHash1, uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders([encodeIOCOrder(order0), encodeLimitOrder(order1)], size);
        assertPositions(alice, size, quote, 0, quote * 1e18 / stdMath.abs(size));
        assertPositions(bob, -size, quote, 0, quote * 1e18 / stdMath.abs(size));
    }

    function prepareIOCOrder(uint ammIndex, uint traderKey, int size, uint price, bool reduceOnly) internal view returns (
        address trader,
        IImmediateOrCancelOrders.Order memory order,
        bytes32 orderHash
    ) {
        trader = vm.addr(traderKey);
        order = IImmediateOrCancelOrders.Order(
            1, // orderType
            block.timestamp + expirationCap, // expireAt
            ammIndex,
            trader,
            size,
            price,
            block.timestamp, // salt
            reduceOnly
        );

        orderHash = juror.getIOCOrderHash(order);
    }

    function placeIOCOrder(uint ammIndex, uint traderKey, int size, uint price, bool reduceOnly) internal returns (IImmediateOrCancelOrders.Order memory, bytes32) {
        IImmediateOrCancelOrders.Order[] memory order = new IImmediateOrCancelOrders.Order[](1);
        address trader;
        bytes32 orderHash;
        (trader, order[0], orderHash) = prepareIOCOrder(ammIndex, traderKey, size, price, reduceOnly);
        vm.prank(trader);
        iocOrderBook.placeOrders(order);
        return (order[0], orderHash);
    }

    function encodeIOCOrder(IImmediateOrCancelOrders.Order memory order) internal pure returns (bytes memory) {
        return abi.encode(1, abi.encode(order));
    }
}
