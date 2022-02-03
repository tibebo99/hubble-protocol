const { expect } = require('chai')

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
    assertBounds
} = require('./utils')

describe('Hubble Viewer', async function() {
    describe('getMakerExpectedMFAndLiquidationPrice when taker+maker', async function() {
        before('alice adds liquidity', async function() {
            signers = await ethers.getSigners()
            alice = signers[0].address

            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)
            await clearingHouse.setParams(
                1e5 /** maintenance margin */,
                1e5 /** minimum allowable margin */,
                5e2 /** tradeFee */,
                5e4 /** liquidationPenalty */
            )

            // add margin
            margin = _1e6.mul(4000)
            await addMargin(signers[0], margin)
            const liquidity = _1e18.mul(10)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.addLiquidity(0, liquidity, dToken)
        })

        it('leaderboard - takerMargins is 0', async function() {
            const { makerMargins, takerMargins } = await hubbleViewer.leaderboard([alice])
            assertBounds(makerMargins[0], _1e6.mul(3999), _1e6.mul(4000))
            expect(takerMargins[0]).to.eq(ZERO)
        })

        it('increase taker position', async function() {
            // alice longs
            const baseAssetQuantity = _1e18.mul(5)
            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)
            // alice longs again
            quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(903)
        })

        it('leaderboard', async function() {
            const { makerMargins, takerMargins } = await hubbleViewer.leaderboard([alice])
            assertBounds(makerMargins[0], _1e6.mul(3990), _1e6.mul(3995))
            assertBounds(takerMargins[0], _1e6.mul(3974), _1e6.mul(3975))
        })

        it('reduce taker position', async function() {
            // alice shorts - netTakerPosition 5+5-5 = 5
            const baseAssetQuantity = _1e18.mul(-5)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(702)
        })

        it('reverse taker position', async function() {
            // alice shorts - netTakerPosition 5-15 = -10
            const baseAssetQuantity = _1e18.mul(-15)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1100)
        })

        it('alice adds more liquidity', async function() {
            await addMargin(signers[0], _1e6.mul(2000))
            const liquidity = _1e18.mul(10)
            const { fillAmount: vUsd } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, false)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.addLiquidity(0, liquidity, dToken)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1097)
        })

        it('alice removes liquidity', async function() {
            const liquidity = _1e18.mul(5)
            const { fillAmount: vUsd } = await hubbleViewer.getMakerQuote(0, liquidity, true, false)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, true)
            const { vAsset, dToken } = await amm.makers(alice)
            const dTokenAmount = liquidity.mul(dToken).div(vAsset)
            await clearingHouse.removeLiquidity(0, dTokenAmount, 0, 0)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1196)
        })
    })
})
