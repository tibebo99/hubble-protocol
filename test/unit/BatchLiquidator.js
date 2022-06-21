
const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    impersonateAcccount,
    forkCChain
} = require('../utils')

const JoeFactory = '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10'
const Wavax = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'
const Usdc = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const JoeRouter = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const wavaxWhale = '0x9d1968765e37f5cbd4f1c99a012cf0b5b07067ae' // 381 wavax
// const usdcWhale = '0x7d0f7ad75687d0616701126ef6d0dc6e9725d435' // 100k usdc

describe('Atomic liquidations', async function() {
    before(async function() {
        await forkCChain(16010497)
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin, charlie ] = signers)
        alice = signers[0].address
        wavax = await ethers.getContractAt('IERC20', Wavax)
        usdc = await ethers.getContractAt('IERC20', Usdc)
        ;({ marginAccount, clearingHouse, vusd, oracle, marginAccountHelper } = await setupContracts({ reserveToken: usdc.address }))
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setParams(
            1e5 /** maintenance margin */,
            1e5 /** minimum allowable margin */,
            5e2 /** tradeFee */,
            5e4 /** liquidationPenalty */
        )

        await amm.setLiquidationParams(100, 1e6)
        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            clearingHouse.address,
            marginAccount.address,
            vusd.address,
            Usdc,
            Wavax,
            JoeRouter
        )

        // addCollateral
        const avaxOraclePrice = 1e6 * 17 // joe pool price at forked block
        await oracle.setUnderlyingPrice(Wavax, avaxOraclePrice),
        await marginAccount.whitelistCollateral(Wavax, 0.8 * 1e6) // weight = 0.8

        // addMargin
        const avaxMargin = _1e18.mul(1000 * 1e6).div(avaxOraclePrice) // $1000, decimals = 18
        await impersonateAcccount(wavaxWhale)
        await wavax.connect(ethers.provider.getSigner(wavaxWhale)).transfer(alice, avaxMargin)
        await wavax.approve(marginAccount.address, avaxMargin),
        await marginAccount.addMargin(1, avaxMargin)

        // alice makes a trade
        await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        // bob makes a counter-trade
        const vusdMargin = _1e6.mul(20000)
        await vusd.connect(admin).mint(bob.address, vusdMargin)
        await vusd.connect(bob).approve(marginAccount.address, vusdMargin)
        await marginAccount.connect(bob).addMargin(0, vusdMargin)
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)

        // liquidate alice position
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        await clearingHouse.connect(liquidator1).liquidateTaker(alice)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidate and sell avax', async function() {
        // repay 50%
        const debt = await marginAccount.margin(0, alice)
        const repay = debt.div(-2)
        await vusd.connect(admin).mint(batchLiquidator.address, repay)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        const minUsdcOut = repay.add(repay.mul(3).div(100)) // min 3% profit
        await batchLiquidator.liquidateAndSellAvax(alice, repay, 0)

        remainingDebt = debt.add(repay)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.gte(minUsdcOut)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(remainingDebt)
        // alice is still liquidable
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('flash loan and liquidate', async function() {
        // withdraw usdc from batchLiquidator
        await batchLiquidator.withdraw(usdc.address)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        // repay whole debt
        const minProfit = _1e18.mul(9).div(10) // min 0.9 avax profit
        await batchLiquidator.flashLiquidateWithAvax(alice, remainingDebt.mul(-1), minProfit)

        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gte(minProfit)
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
    })
})

describe('Atomic liquidations supernova', async function() {
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
                    blockNumber: 10884594
                }
            }]
        })
        wavax = await ethers.getContractAt('ERC20Mintable', '0x1860619494CdC768949521f488E68da9D10De7E6') // hAVAX
        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            '0xdAb9110f9ba395f72B6D6eB12F687E0DFBb1fb85', // clearingHouse
            '0x4BFC1482ecbbc0d448920ee471312E28f85ab903', // marginAccount
            '0xaE778F08a9bDA83Dd2143405642885a722aaE190', // vusd
            '0x56F959EB63855c179a9022D53DD547dB1C523fFc', // usdc
            wavax.address,
            '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901' // joeRouter
        )
        alice = '0x2eE09408782ea5121A2cEE931793d998cF85CEBE'
        repay = _1e6.mul(100)

        hubbleViewer = await ethers.getContractAt('HubbleViewer', '0x03F075fA17aCc799606F78DB1f17CB0d0f0e2e48')
        marginAccount = await ethers.getContractAt('MarginAccount', '0x4BFC1482ecbbc0d448920ee471312E28f85ab903')
        clearingHouse = await ethers.getContractAt('ClearingHouse', '0xdAb9110f9ba395f72B6D6eB12F687E0DFBb1fb85')
    })

    it('flash loan and liquidate', async function() {
        // console.log(await marginAccount.weightedAndSpotCollateral(alice))
        const b4 = await hubbleViewer.userInfo(alice)

        // const liquidator = '0x3C4904418a53b22BD1b6aA69694E29d55bdab398'
        // await impersonateAcccount(liquidator)
        // await marginAccount.connect(ethers.provider.getSigner(liquidator)).liquidateExactRepay(alice, debt, 1, 0)

        // await batchLiquidator.flashLiquidateWithAvax(alice, debt, 0)
        await batchLiquidator.liquidateMarginAccount(alice, repay)
        const after = await hubbleViewer.userInfo(alice)

        expect(b4[0].add(repay)).to.eq(after[0])
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gt(ZERO)
        expect(b4[1]).to.gt(after[1])
    })
})
