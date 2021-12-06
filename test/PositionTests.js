const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e18, ZERO },
    assertions,
    getTradeDetails,
    setupContracts
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('Position Tests', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))

        contracts = await setupContracts(TRADE_FEE)
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

        // add margin
        margin = _1e6.mul(1000)
        await addMargin(signers[0], margin)
    })

    describe('single trader', async () => {
        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))
            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount)).to.be.true

            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(ZERO)
            expect(notionalPosition).lt(quoteAsset) // less vUSD will be received when closing a long position
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect((await amm.lastPrice()).gt(_1e6.mul(1000))).to.be.true // rate increases after long

            const [ pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).lt(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
        })

        it('two longs', async () => {
            const baseAssetQuantity = _1e18.mul(4)
            amount = _1e6.mul(4050)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const {
                marginFraction : expectedMarginFraction,
                liquidationPrice
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)
            expect(liquidationPrice).to.eq('980973753')

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)
            // tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount.mul(2))).to.be.true
            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4)) // slightly different because of vamm fee

            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(ZERO)
            expect(notionalPosition).lt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* exact base asset */, amount /* min_dy */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount)).to.be.true

            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(quoteAsset) // more vUSD required to close a short position
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.abs())
            expect((await amm.lastPrice()).lt(_1e6.mul(1000))).to.be.true // rate decreases after short

            const [ pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).lt(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity.mul(-1)))
        })

        it('two shorts', async () => {
            const baseAssetQuantity = _1e18.mul(-4)
            amount = _1e6.mul(3900)

            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const {
                marginFraction : expectedMarginFraction,
                quoteAssetQuantity,
                liquidationPrice
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)
            expect(liquidationPrice).to.eq('1019637444')

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0, baseAssetQuantity, quote)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount.mul(2))).to.be.true
            expect(trade2.quoteAsset).to.eq(quoteAssetQuantity)
            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4)) // slightly different because of vamm fee

            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2).abs())
        })

        it('long + short', async () => {
            let baseAssetQuantity = _1e18.mul(5)

            let quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)
            ;({ marginFraction, quoteAssetQuantity: quote, liquidationPrice } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity))

            // since all positions will be closed
            expect(marginFraction).to.eq(ethers.constants.MaxInt256)
            expect(liquidationPrice).to.eq(ZERO)

            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, quote /* min_dy */)

            const swapEvents = await amm.queryFilter('Swap')
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect(swapEvents[0].args.openInterestNotional).to.eq(baseAssetQuantity.abs())
            expect(swapEvents[1].args.openInterestNotional).to.eq(ZERO)
        })

        it('short + long', async () => {
            let baseAssetQuantity = _1e18.mul(-3)

            let quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* exact base asset */, quote /* min_dy */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)
            ;({ marginFraction, quoteAssetQuantity: quote, liquidationPrice } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity))

            // since all positions will be closed
            expect(marginFraction).to.eq(ethers.constants.MaxInt256)
            expect(liquidationPrice).to.eq(ZERO)

            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)

            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction,
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('long + bigger short + bigger long', async () => {
            // Long
            let baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, await amm.getQuote(baseAssetQuantity))

            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(5))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            const { unrealizedPnl: unrealizedPnl1 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl1).lt(ZERO)
            // Short
            baseAssetQuantity = _1e18.mul(-7)

            let {
                marginFraction : expectedMarginFraction,
                quoteAssetQuantity
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)

            tx = await clearingHouse.openPosition(0, baseAssetQuantity, await amm.getQuote(baseAssetQuantity))

            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(2))
            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4).sub(1)) // slightly different because of vamm fee
            expect(trade2.quoteAsset).gt(quoteAssetQuantity) // slightly higher because less fee is paid while closing initial position

            let fee = trade1.fee.add(trade2.fee)
            await assertions(contracts, alice, {
                size: _1e18.mul(-2), // 5 - 7
                margin: margin.sub(fee).add(unrealizedPnl1) // now realized
            })

            const { unrealizedPnl: unrealizedPnl2 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl2).lt(ZERO)

            // Long
            baseAssetQuantity = _1e18.mul(10)
            ;({ marginFraction : expectedMarginFraction } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity))

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote.add(7000)) // slightly higher quote value because of vamm fee while closing short position and then opening a long position of 8
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(8), // 5 - 7 + 10
                margin: margin.sub(fee).add(unrealizedPnl1).add(unrealizedPnl2)
            })
            const { unrealizedPnl: unrealizedPnl3 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl3).lt(ZERO)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(8))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4).sub(1)) // slightly different because of vamm fee
        })

        it('short + bigger long + bigger short', async () => {
            // Short
            let tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-5) /* short exactly */, 0 /* short at any price */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(5))
            const { unrealizedPnl: unrealizedPnl1 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl1).lt(ZERO)

            // Long
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(7) /* exact base asset */, _1e6.mul(7100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            let fee = trade1.fee.add(trade2.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(2), // -5 + 7
                margin: margin.sub(fee).add(unrealizedPnl1) // pnl realized
            })
            const { unrealizedPnl: unrealizedPnl2 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl2).lt(ZERO)

            // Short
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-10) /* long exactly */, 0)
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(-8), // -5 + 7 - 10
                margin: margin.sub(fee).add(unrealizedPnl1).add(unrealizedPnl2)
            })
            const { unrealizedPnl: unrealizedPnl3 } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(unrealizedPnl3).lt(ZERO)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(8))
        })

        it("open an empty position", async () => {
            await expect(clearingHouse.openPosition(0, 0, 0)).to.be.revertedWith('CH: baseAssetQuantity == 0')
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('long + smaller short', async () => {
            const longBaseAssetQuantity = _1e18.mul(5)

            let quote = await amm.getQuote(longBaseAssetQuantity)
            let tx = await clearingHouse.openPosition(0 /* amm index */, longBaseAssetQuantity /* long exactly */, quote /* max_dx */)
            let { unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            let trade = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade.fee

            const shortBaseAssetQuantity = _1e18.mul(-1)

            quote = await amm.getQuote(shortBaseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, shortBaseAssetQuantity, quote /* min_dy */)
            trade = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade.fee)

            const swapEvents = await amm.queryFilter('Swap')
            const realizedPnl = unrealizedPnl.mul(shortBaseAssetQuantity.abs()).div(longBaseAssetQuantity)
            unrealizedPnl = unrealizedPnl.sub(realizedPnl)
            const notionalPosition = await amm.getNotionalPosition(_1e18.mul(4))

            await assertions(contracts, alice, {
                size: longBaseAssetQuantity.add(shortBaseAssetQuantity),
                openNotional: notionalPosition.sub(unrealizedPnl),
                unrealizedPnl,
                margin: margin.sub(fee).add(realizedPnl)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect(swapEvents[0].args.openInterestNotional).to.eq(longBaseAssetQuantity.abs())
            expect(swapEvents[1].args.openInterestNotional).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity))
        })

        it('short + smaller long', async () => {
            const shortBaseAssetQuantity = _1e18.mul(-5)

            let quote = await amm.getQuote(shortBaseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, shortBaseAssetQuantity, quote)
            let { unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            let trade = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade.fee

            const longBaseAssetQuantity = _1e18.mul(1)

            quote = await amm.getQuote(longBaseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, longBaseAssetQuantity, quote /* min_dy */)
            trade = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade.fee)

            const swapEvents = await amm.queryFilter('Swap')
            const realizedPnl = unrealizedPnl.mul(longBaseAssetQuantity).div(shortBaseAssetQuantity.abs())
            unrealizedPnl = unrealizedPnl.sub(realizedPnl)
            const notionalPosition = await amm.getNotionalPosition(_1e18.mul(-4))

            await assertions(contracts, alice, {
                size: longBaseAssetQuantity.add(shortBaseAssetQuantity),
                openNotional: notionalPosition.add(unrealizedPnl),
                unrealizedPnl,
                margin: margin.sub(fee).add(realizedPnl)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity).abs())
            expect(swapEvents[0].args.openInterestNotional).to.eq(shortBaseAssetQuantity.abs())
            expect(swapEvents[1].args.openInterestNotional).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity).abs())
        })
    })

    describe('two traders', async () => {
        it('close a safe position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, margin)
            await clearingHouse.connect(bob).openPosition(0 /* amm index */, _1e18.mul(3) /* exact base asset */, ethers.constants.MaxUint256)

            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(5100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close a position which is slightly over maintenanceMarginRatio', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(10000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(35), _1e6.mul(40000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close an under collateral position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(20000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), _1e6.mul(73000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('liquidation', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(20000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), _1e6.mul(73000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            // console.log(notionalPosition.toString())
            await clearingHouse.connect(signers[2]).liquidate(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            const toInsurance = liquidationPenalty.div(2)
            // console.log((await vusd.balanceOf(signers[2].address)).toString())
            expect(await vusd.balanceOf(signers[2].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
        })
    })

    describe('two amms', async function() {
        beforeEach(async function() {
            const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
            const avax = await ERC20Mintable.deploy('avax', 'avax', 6)
            const secondAmm = await utils.setupAmm(
                alice,
                [ registry.address, avax.address, 'AVAX-Perp' ],
                65, // initialRate => avax = $65
                10000, // initialLiquidity = 10k avax
                false,
                1 // amm index
            )
            const markets = await clearingHouse.markets()
            expect(markets[0].amm).to.eq(amm.address)
            expect(markets[0].underlying).to.eq(weth.address)
            expect(markets[1].amm).to.eq(secondAmm.amm.address)
            expect(markets[1].underlying).to.eq(avax.address)

            amm = secondAmm.amm
            contracts.amm = amm
        })

        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(100) // 100 * 65 = 6500
            amount = _1e6.mul(1e4)

            const quote = await amm.getQuote(baseAssetQuantity)
            expect(quote.lte(amount)).to.be.true // this asserts that long was executed at a price <= amount

            // console.log({ quote: quote.toString() })
            const tx = await clearingHouse.openPosition(1 /* amm index */, baseAssetQuantity, quote /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(ZERO)
            expect(notionalPosition).lt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect((await amm.lastPrice()).gt(_1e6.mul(65))).to.be.true // rate increases after long

            const [ _, pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).to.lt(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
        })
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
