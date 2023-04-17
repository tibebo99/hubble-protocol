// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@layerzerolabs/solidity-examples/contracts/mocks/LZEndpointMock.sol";
import "../../contracts/OrderBook.sol";
import "../../contracts/ClearingHouse.sol";
import "../../contracts/AMM.sol";
import "../../contracts/MarginAccount.sol";
import "../../contracts/MarginAccountHelper.sol";
import "../../contracts/InsuranceFund.sol";
import "../../contracts/HubbleReferral.sol";
import "../../contracts/MinimalForwarder.sol";
import "../../contracts/Registry.sol";
import "../../contracts/HubbleViewer.sol";
import "../../contracts/HGT.sol";
import "../../contracts/HGTRemote.sol";
import "../../contracts/tests/TestOracle.sol";
import "../../contracts/tests/ERC20Mintable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

abstract contract Utils is Test {
    ProxyAdmin public proxyAdmin;
    MinimalForwarder public forwarder;
    ERC20Mintable public usdc;
    VUSD public husd;
    MarginAccount public marginAccount;
    MarginAccountHelper public marginAccountHelper;
    ClearingHouse public clearingHouse;
    OrderBook public orderBook;
    AMM public amm;
    TestOracle public oracle;
    InsuranceFund public insuranceFund;
    HubbleReferral public hubbleReferral;
    Registry public registry;
    HubbleViewer public hubbleViewer;
    RestrictedErc20 public wavax;
    address public feeSink = makeAddr("feeSink");
    address public governance = makeAddr("governance");
    int public makerFee = 0.05 * 1e4; // 0.05%
    int public takerFee = 0.05 * 1e4; // 0.05%
    uint public liquidationPenalty = 5 * 1e4; // 5%
    // for layer0 bridge test
    uint16 public baseChainId = 1;
    uint16 public otherChainId = 2;
    LZEndpointMock public lzEndpointBase;
    LZEndpointMock public lzEndpointOther;
    HGT public hgt;
    HGTRemote public hgtRemote;

    uint public aliceKey;
    address public alice;
    uint public bobKey;
    address public bob;

    // used for temporary variables in test functions to avoid stack too deep
    uint256[50] public temp;

    function setupContracts() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");

        proxyAdmin = new ProxyAdmin();
        forwarder = new MinimalForwarder();
        usdc = new ERC20Mintable('USD Coin', 'USDC', 6);

        VUSD vusdImpl = new VUSD();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(vusdImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(VUSD.initialize.selector, 'Hubble USD', 'hUSD')
        );
        husd = VUSD(address(proxy));

        MarginAccount maImpl = new MarginAccount(address(forwarder));
        proxy = new TransparentUpgradeableProxy(
            address(maImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(MarginAccount.initialize.selector, governance, address(husd))
        );
        marginAccount = MarginAccount(payable(address(proxy)));
        husd.grantRole(keccak256("MINTER_ROLE"), address(marginAccount));

        marginAccountHelper = new MarginAccountHelper(
            address(marginAccount),
            address(husd),
            address(usdc) // pass a dummy address that supports safeApprove
        );

        InsuranceFund ifImpl = new InsuranceFund();
        proxy = new TransparentUpgradeableProxy(
            address(ifImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(InsuranceFund.initialize.selector, governance)
        );
        insuranceFund = InsuranceFund(address(proxy));

        TestOracle oracleImpl = new TestOracle();
        proxy = new TransparentUpgradeableProxy(
            address(oracleImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(Oracle.initialize.selector, governance)
        );
        oracle = TestOracle(address(proxy));
        vm.prank(governance);
        oracle.setStablePrice(address(husd), 1e6);

        HubbleReferral referralImpl = new HubbleReferral();
        proxy = new TransparentUpgradeableProxy(
            address(referralImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(HubbleReferral.initialize.selector, governance)
        );
        hubbleReferral = HubbleReferral(address(proxy));

        TransparentUpgradeableProxy clProxy = new TransparentUpgradeableProxy(
            address(oracle) /** random contarct address */, address(proxyAdmin), "");

        OrderBook obImpl = new OrderBook(address(clProxy));
        proxy = new TransparentUpgradeableProxy(
            address(obImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(OrderBook.initialize.selector, "Hubble", "2.0", governance)
        );
        orderBook = OrderBook(address(proxy));

        ClearingHouse clImpl = new ClearingHouse(address(forwarder));
        proxyAdmin.upgradeAndCall(clProxy, address(clImpl), abi.encodeWithSelector(
            ClearingHouse.initialize.selector,
            governance,
            feeSink,
            address(marginAccount),
            address(orderBook),
            address(husd),
            address(hubbleReferral)
        ));
        clearingHouse = ClearingHouse(address(clProxy));

        registry = new Registry(address(oracle), address(clearingHouse), address(insuranceFund), address(marginAccount), address(husd));

        hubbleViewer = new HubbleViewer(address(clearingHouse), address(marginAccount), address(registry));

        vm.startPrank(governance);
        marginAccount.syncDeps(address(registry), 5e4); // liquidationIncentive = 5% = .05 scaled 6
        insuranceFund.syncDeps(address(registry));
        clearingHouse.setParams(
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            takerFee,
            makerFee,
            50, // referralShare = .5bps
            100, // feeDiscount = 1bps
            0.05 * 1e6 // liquidationPenalty = 5%
        );
        vm.stopPrank();

        wavax = setupRestrictedTestToken('Hubble Avax', 'hWAVAX', 18);
        amm = setupAmm(
            "AVAX-PERP",
            address(wavax),
            address(oracle),
            5e18, // 5 avax min size
            governance,
            address(clearingHouse),
            address(proxyAdmin),
            20 * 1e6 // $20 initial price
        );

        lzEndpointBase = new LZEndpointMock(baseChainId);
        lzEndpointOther = new LZEndpointMock(otherChainId);

        HGT hgtImpl = new HGT(address(lzEndpointBase));
        proxy = new TransparentUpgradeableProxy(
            address(hgtImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(InsuranceFund.initialize.selector, governance)
        );
        hgt = HGT(address(proxy));

        HGTRemote hgtRemoteImpl = new HGTRemote(address(lzEndpointOther), address(usdc));
        proxy = new TransparentUpgradeableProxy(
            address(hgtRemoteImpl),
            address(proxyAdmin),
            abi.encodeWithSelector(InsuranceFund.initialize.selector, governance)
        );
        hgtRemote = HGTRemote(address(proxy));
    }

    function setupRestrictedTestToken(string memory name_, string memory symbol, uint8 decimals) internal returns (RestrictedErc20 token) {
        token = new RestrictedErc20(name_, symbol, decimals);
        token.grantRole(keccak256("TRANSFER_ROLE"), address(marginAccount));
    }

    function setupAmm(
        string memory name_,
        address underlyingAsset,
        address oracle_,
        uint minSizeRequirement,
        address governance_,
        address clearingHouse_,
        address proxyAdmin_,
        int initialPrice
    ) internal returns (AMM amm_) {
        vm.startPrank(governance);
        TestOracle(oracle_).setUnderlyingTwapPrice(underlyingAsset, initialPrice);
        TestOracle(oracle_).setUnderlyingPrice(underlyingAsset, initialPrice);
        vm.stopPrank();

        AMM ammImpl = new AMM(clearingHouse_);
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(ammImpl),
            proxyAdmin_,
            abi.encodeWithSelector(AMM.initialize.selector, name_, underlyingAsset, oracle_, minSizeRequirement, governance_)
        );
        amm_ = AMM(address(proxy));

        vm.prank(governance);
        ClearingHouse(clearingHouse).whitelistAmm(address(amm_));
    }

    /**
    @dev only supports usdc collateral for now
    */
    function addMargin(address trader, uint margin) internal {
        uint hgtRequired = margin * 1e12;
        vm.deal(trader, hgtRequired);

        vm.startPrank(trader);
        marginAccountHelper.addVUSDMarginWithReserve{value: hgtRequired}(margin);
        vm.stopPrank();
    }

    function prepareOrder(uint ammIndex, uint traderKey, int size, uint price) internal view returns (
        address trader,
        IOrderBook.Order memory order,
        bytes memory signature,
        bytes32 orderHash
    ) {
        trader = vm.addr(traderKey);
        order = IOrderBook.Order(
            ammIndex,
            trader,
            size,
            price,
            block.timestamp
        );

        orderHash = orderBook.getOrderHash(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(traderKey, orderHash);
        signature = abi.encodePacked(r, s, v);
    }

    function placeOrder(uint ammIndex, uint traderKey, int size, uint price) internal returns (IOrderBook.Order memory, bytes memory, bytes32) {
        (address trader, IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = prepareOrder(ammIndex, traderKey, size, price);
        vm.prank(trader);
        orderBook.placeOrder(order, signature);
        return (order, signature, orderHash);
    }

    function placeAndExecuteOrder(uint ammIndex, uint trader1Key, uint trader2Key, int size, uint price, bool sameBlock) internal returns (uint margin) {
        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[2] memory ordersHash;

        (orders[0], signatures[0], ordersHash[0]) = placeOrder(ammIndex, trader1Key, int(stdMath.abs(size)), price);
        if (!sameBlock) {
            vm.roll(block.number + 1);
        }
        (orders[1], signatures[1], ordersHash[1]) = placeOrder(ammIndex, trader2Key, -int(stdMath.abs(size)), price);

        margin = stdMath.abs(size) * price / 2e18; // 2x leverage
        addMargin(alice, margin);
        addMargin(bob, margin);
        orderBook.executeMatchedOrders(orders, signatures, int(stdMath.abs(size)));
    }

    function assertPositions(address trader, int size, uint openNotional, int unrealizedPnl, uint avgOpen) internal {
        HubbleViewer.Position[] memory positions = hubbleViewer.userPositions(trader);
        assertEq(positions[0].size, size);
        assertEq(positions[0].openNotional, openNotional);
        assertEq(positions[0].unrealizedPnl, unrealizedPnl);
        assertApproxEqAbs(positions[0].avgOpen, avgOpen, 1);
    }

    function mintVusd(address trader, uint amount) internal {
        vm.prank(trader);
        uint scaledAmount = amount * 1e12;
        if (trader.balance < scaledAmount) {
            vm.deal(trader, scaledAmount);
        }
        husd.mintWithReserve{value: scaledAmount}(address(trader), amount);
    }
}
