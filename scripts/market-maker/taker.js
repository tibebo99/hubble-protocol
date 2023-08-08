const ethers = require('ethers')

const { Exchange, getOpenSize, getOrdersWithinBounds, prettyPrint, toRawOrders, findError, parseAndLogError } = require('./exchange');
const { constants: { _1e6, _1e18 }, bnToFloat } = require('../../test/utils');

const hubblev2next = require('../hubblev2next');
let { marketInfo } = hubblev2next
// marketInfo = marketInfo.slice(0, 1)

const updateFrequency = 1e3 // 1s
const dryRun = false

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
// const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL_ARCHIVE)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_TAKER, provider);
const exchange = new Exchange(provider, hubblev2next)

let nonce
const main = async () => {
    nonce = await provider.getTransactionCount(signer.address)
    await marketTaker()
}

const marketTaker = async () => {
    try {
        // let nonce = await signer.getTransactionCount()
        // cancel all pending orders
        try {
            // const myOrders = await exchange.getTraderOpenOrders(signer.address, 0)
            const myOrders = await exchange.getTraderOpenOrders(signer.address)
            // console.log('myOrders:', myOrders)
            if (myOrders.length) {
                const txs = await exchange.cancelOrders(signer, toRawOrders(signer.address, myOrders), { nonce })
                nonce += txs.length
            }
        } catch(e) {
            if (e && e.error && e.error.toString().includes('OB_Order_does_not_exist')) {
                // fail silently because order cancel only fails when it was already matched
            } else {
                console.error('cancel orders failed with:', e)
            }
        }

        // only works if bibliophile is deployed
        let [ sizes, { margin }, underlyingPrices ] = await Promise.all([
            exchange.getPositionSizes(signer.address),
            exchange.getNotionalPositionAndMargin(signer.address),
            exchange.getUnderlyingPrice()
        ])
        // console.log('sizes:', sizes.map(s => bnToFloat(s, 18)))
        margin = bnToFloat(margin)
        // underlyingPrices[0] = 2150

        // marketInfo = marketInfo.slice(0, 1)
        let activeMarkets = 0
        for (let i = 0; i < marketInfo.length; i++) {
            if (marketInfo[i].active) activeMarkets++
        }

        const targetMargin = 1e5 * activeMarkets
        if (!dryRun && margin < targetMargin) {
            // mint native
            const toMint = parseFloat((targetMargin * 1.2 - margin).toFixed(0)) // mint 20% extra
            console.log(`minting ${toMint} margin for myself...`)
            const nativeMinter = new ethers.Contract(
                '0x0200000000000000000000000000000000000001',
                require('../../artifacts/contracts/precompiles/INativeMinter.sol/INativeMinter.json').abi,
                provider
            )
            await nativeMinter.connect(signer).mintNativeCoin(signer.address, _1e18.mul(toMint), { nonce: nonce++ })
            await exchange.marginAccountHelper.connect(signer).addVUSDMarginWithReserve(_1e6.mul(toMint), { nonce: nonce++, value: _1e18.mul(toMint) })
        }

        try {
            let orders = []
            for (let i = 0; i < marketInfo.length; i++) {
                if (!marketInfo[i].active) continue
                const _orders = (await runForMarket(i, underlyingPrices[i], sizes[i])).filter(o => o)
                // console.log({ market: marketInfo[i].name, size: bnToFloat(sizes[i], 18), orders: prettyPrint(_orders, marketInfo) })
                if (_orders.length) {
                    try {
                        // const estimateGas = await exchange.iocOrderBook.connect(signer).estimateGas.placeOrders(_orders)
                        // console.log({ market: i, numOrders: _orders.length, estimateGas })
                        orders = orders.concat(_orders)
                    } catch (e) {
                        console.log(`estimateGas failed for market ${i}`, _orders)
                        parseAndLogError(e)
                    }
                }
            }

            if (orders.length) {
                if (dryRun) {
                    const estimateGas = await exchange.iocOrderBook.connect(signer).estimateGas.placeOrders(orders)
                    // const estimateGas = await exchange.orderBook.connect(signer).estimateGas.placeOrders(orders)
                    console.log({ numOrders: orders.length, estimateGas })
                    // console.log({ orders: prettyPrint(orders, marketInfo), numOrders: orders.length, estimateGas })
                } else {
                    console.log(`placing ${orders.length} orders...`)
                    // console.log(prettyPr int(orders, marketInfo))
                    const txs = await exchange.placeIOCOrders(signer, orders, nonce)
                    console.log(`${(await txs[0].wait()).status == 1 ? 'success' : 'failure'}: ${txs[0].hash}`)
                    nonce += txs.length
                }
            }
        } catch (e) {
            parseAndLogError(e)
        }
    } catch (e) {
        console.error('Taker failed with:', e)
    }

    // Schedule the next update
    setTimeout(marketTaker, updateFrequency);
}

async function runForMarket(market, underlyingPrice, nowSize) {
    const { x, minOrderSize, taker: { baseLiquidityInMarket } } = marketInfo[market]
    let { bids, asks } = await exchange.fetchOrderBook(market)
    // console.log({ asks, bids, underlyingPrice })

    const validBids = getOrdersWithinBounds(bids, underlyingPrice * (1-x), underlyingPrice * 2 /* high upper bound */)
    const longsOpenSize = getOpenSize(validBids)

    const validAsks = getOrdersWithinBounds(asks, underlyingPrice, underlyingPrice * 1.15)
    // const validAsks = getOrdersWithinBounds(asks, 0, underlyingPrice * (1+x))
    const shortsOpenSize = getOpenSize(validAsks)

    const _nowSize = bnToFloat(nowSize, 18)
    // console.log({ market, _nowSize, longsOpenSize, shortsOpenSize, baseLiquidityInMarket })
    // console.log({ nowSize, _nowSize })
    // in each run we will do only 1 taker order
    // priorotize reducing position
    let shouldShort = false
    let shouldLong = false
    if (_nowSize > 0) {
        shouldShort = true
    } else if (_nowSize < 0) {
        shouldLong = true
    } else {
        // reducing position is not possible, so we will just take a random side
        if (Math.random() > 0.5) {
            shouldShort = true
        } else {
            shouldLong = true
        }
    }

    if (shouldShort && longsOpenSize > baseLiquidityInMarket + minOrderSize) {
        return decideStrategy(market, validBids, -(longsOpenSize - baseLiquidityInMarket), nowSize)
    }
    if (shouldLong && shortsOpenSize > baseLiquidityInMarket + minOrderSize) {
        return decideStrategy(market, validAsks, shortsOpenSize - baseLiquidityInMarket, nowSize)
    }
    return []
}

function decideStrategy(market, orders, totalSize, nowSize) {
    // console.log({ market, orders, totalSize })
    if (!orders.length) return []

    const { minOrderSize, taker: { maxOrderSize }, toFixed } = marketInfo[market]
    totalSize = parseFloat(totalSize.toFixed(toFixed))

    let size = 0
    let price
    for (let i = 0; i < orders.length; i++) {
        // console.log({ order: orders[i] })
        size += Math.abs(orders[i].size)
        if (size >= Math.abs(totalSize) || i == orders.length - 1) {
            price = orders[i].price
            break
        }
    }
    const _nowSize = bnToFloat(nowSize, 18)
    // console.log({ nowSize, _nowSize, totalSize })

    const _orders = []
    if (_nowSize * totalSize < 0) {
        // reduce position first
        let _order
        if (Math.abs(_nowSize) <= Math.abs(totalSize)) {
            _order = exchange.buildIOCOrderObj(signer.address, market, -_nowSize, price, true)
            _order.baseAssetQuantity = nowSize.mul(-1) // decimal precision can cause the above to be not super accurate sometimes
        } else {
            _order = exchange.buildIOCOrderObj(signer.address, market, totalSize, price, true)
        }
        _orders.push(_order)
    } else if (Math.abs(totalSize) >= minOrderSize) {
        _orders.push(exchange.buildIOCOrderObj(signer.address, market, Math.min(totalSize, maxOrderSize), price))
    }
    return _orders
}

function randomFloat(min, max) {
    return Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
}

// Start the taker script
main();
