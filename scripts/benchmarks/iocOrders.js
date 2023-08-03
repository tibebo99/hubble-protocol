const assert = require('assert')
const utils = require('../../test/utils')
const { config, deployToken, setupAMM, addMargin } = require('../common')

const { Exchange } = require('../market-maker/exchange')

const {
    constants: { _1e6 },
    setupContracts,
    getTxOptions,
    sleep,
    txOptions
} = utils

const gasLimit = 5e6

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have deposited 40k hUSD each
 */

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = gasLimit

    const { orderBook, clearingHouse, marginAccount, hubbleViewer } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        mockOrderBook: false,
        testClearingHouse: false,
        setupAMM: false,
        genesisProxies: {
            orderBookGenesisAddress: config.OrderBook,
            marginAccountGenesisAddress: config.MarginAccount,
            clearingHouseGenesisAddress: config.ClearingHouse,
            bibliophilePrecompileAddress: config.Bibliophile,
            jurorPrecompileAddress: config.Juror,
            iocOrderBookGenesisAddress: config.IocOrderBook,
        },
    })

    // calling setGenesisAdmin again on proxy will fail
    console.log('assert that calling setGenesisAdmin again on proxy will fail')
    const contracts = [ orderBook, marginAccount, clearingHouse ]
    for (let i = 0; i < contracts.length; i++) {
        const genesisTUP = await ethers.getContractAt('GenesisTUP', contracts[i].address)
        try {
            await genesisTUP.estimateGas.setGenesisAdmin(alice.address)
            throw new Error('should have failed')
        } catch (e) {
            // console.log(e, Object.keys(e))
            assert.ok(e.error.toString().includes('ProviderError: execution reverted: already initialized'))
        }
    }

    const tasks = []
    // whitelist evm address for order execution transactions
    const validators = [
        '0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'
    ]
    validators.forEach(validator => {
        tasks.push(orderBook.setValidatorStatus(ethers.utils.getAddress(validator), true, getTxOptions()))
    })

    await Promise.all(tasks)

    // await sleep(5)
    // await addMarginAgain() // doesnt work for some reason
    // console.log(JSON.stringify(await generateConfig(hubbleViewer.address), null, 0))
}

async function addMarginAgain() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)

    const tx = await addMargin(alice, _1e6.mul(40000))
    // console.log(await tx.wait())

    await addMargin(bob, _1e6.mul(40000))
    await sleep(3)
    await getAvailableMargin()
}

async function getAvailableMargin() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)

    console.log({
        alice: await ma.getAvailableMargin(alice.address),
        bob: await ma.getAvailableMargin(bob.address),
    })
}

async function placeIOCOrder() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    marketId = 0

    // txOptions.nonce = await signers[0].getTransactionCount()
    // txOptions.gasLimit = gasLimit

    // const oracleAddress = await exchange.marginAccount.oracle()
    // initialRate = (marketId+1) * 10
    // const underlying = await deployToken(`tok-${marketId}`, `tok-${marketId}`, 18)
    // const ammOptions = {
    //     governance,
    //     name: `Market-${marketId}-Perp`,
    //     underlyingAddress: underlying.address,
    //     initialRate,
    //     oracleAddress,
    //     minSize: 0.1,
    //     testAmm: false,
    //     whitelist: true,
    // }
    // await setupAMM(ammOptions)
    const tx = await exchange.placeIOCOrder(alice, false, marketId, 1, 10)
    console.log(await tx.wait())
}

const exchange = new Exchange(ethers.provider, { contracts: config })
async function runAnalytics() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    const oracleAddress = await exchange.marginAccount.oracle()
    const amms = await exchange.clearingHouse.getAmmsLength()
    await exchange.orderBook.connect(signers[0]).setOrderHandler(1, config.IocOrderBook, getTxOptions())
    let lastMatchedBlock = 0

    for (let i = 0; i < 5; i++) {
        marketId = amms.toNumber() + i
        initialRate = (marketId+1) * 10
        // console.log('deploying new amm')
        const underlying = await deployToken(`tok-${marketId}`, `tok-${marketId}`, 18)
        const ammOptions = {
            governance,
            name: `Market-${marketId}-Perp`,
            underlyingAddress: underlying.address,
            initialRate,
            oracleAddress,
            minSize: 0.1,
            testAmm: false,
            whitelist: true,
        }
        await setupAMM(ammOptions)

        // console.log('sending orders in market-id', marketId)
        // we execute 5 different matching strategies
        let longPrice, shortPrice
        let longFirst = true
        if (i == 0) {
            longPrice = initialRate
            shortPrice = initialRate
            matchPrice = initialRate
        } else if (i == 1) {
            longPrice = initialRate * 1.2 + 1
            shortPrice = initialRate
            matchPrice = initialRate * 1.2
        } else if (i == 2) {
            longPrice = initialRate * 1.2 + 1
            shortPrice = 1
            matchPrice = initialRate * 1.2
        } else if (i == 3) {
            longFirst = false
            shortPrice = initialRate * 1.2
            longPrice = 500
            matchPrice = initialRate * 1.2
        } else if (i == 4) {
            longFirst = false
            shortPrice = initialRate * 0.8 - 1
            longPrice = 500
            matchPrice = initialRate * 0.8
        }

        const { receipt: r, orderPlacedGas: orderPlacedGas_1stTrade } = await doTrades(marketId, longPrice, shortPrice, matchPrice, longFirst)
        // console.log(r)
        assert.ok(r.blockNumber > lastMatchedBlock, `blockNumber ${r.blockNumber} is not greater than ${lastMatchedBlock}`)
        lastMatchedBlock = r.blockNumber

        const { receipt: r2, orderPlacedGas: orderPlacedGas_2ndTrade }= await doTrades(marketId, longPrice, shortPrice, matchPrice, longFirst)
        assert.ok(r2.blockNumber > lastMatchedBlock, `blockNumber ${r2.blockNumber} is not greater than ${lastMatchedBlock}`)
        lastMatchedBlock = r.blockNumber

        console.log({
            // markets: marketId+1,
            // blockNumber: r.blockNumber,
            initialRate, longFirst, longPrice, shortPrice, matchPrice,
            trade_1st: {
                orderPlacedGas: orderPlacedGas_1stTrade,
                orderMatchedGas: r.gasUsed.toNumber(),
            },
            trade_2nd: {
                orderPlacedGas: orderPlacedGas_2ndTrade,
                orderMatchedGas: r2.gasUsed.toNumber(),
            }
        })
    }
}

async function doTrades(marketId, longPrice, shortPrice, matchPrice, longFirst) {
    let tx1, tx2
    const baseQ = marketId+1
    if (longFirst) {
        tx1 = await (await exchange.createLimitOrder(alice, false, marketId, baseQ, longPrice)).wait()
        tx2 = await (await exchange.placeIOCOrder(bob, false, marketId, -baseQ, shortPrice, false, { gasLimit: 1e6 })).wait()
    } else {
        tx1 = await (await exchange.createLimitOrder(bob, false, marketId, -baseQ, shortPrice)).wait()
        tx2 = await (await exchange.placeIOCOrder(alice, false, marketId, baseQ, longPrice, false, { gasLimit: 1e6 })).wait()
    }
    await sleep(3)
    // get the matched order tx
    // get all OrdersMatched events from orderbook contract
    const events = (await exchange.orderBook.queryFilter(exchange.orderBook.filters.OrdersMatched())).sort((a, b) => a.blockNumber - b.blockNumber)
    // console.log('events', events.length)
    const lastMatched = events[events.length - 1]
    // console.log({ lastMatched })
    assert.equal(lastMatched.args.price.toNumber() / 1e6, matchPrice)
    // console.log(tx1.gasUsed.toNumber(), tx2.gasUsed.toNumber())
    return {
        receipt: await lastMatched.getTransactionReceipt(),
        orderPlacedGas: Math.floor((tx1.gasUsed.toNumber() + tx2.gasUsed.toNumber())/2)
    }
}

async function juror() {
    // console.log(await exchange.iocOrderBook.juror())
    // console.log(await exchange.iocOrderBook.expirationCap())
    const trader = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const orders = [
        {
            orderType: 1,
            ammIndex: 2,
            trader,
            baseAssetQuantity: utils.BigNumber.from('1000000000000000000'),
            price: utils.BigNumber.from('30000000'),
            salt: utils.BigNumber.from('52083281634683060362497421357585753067'),
            reduceOnly: false,
            expireAt: Math.floor(Date.now() / 1000) + 3,
        }
    ]
    console.log(await exchange.juror.validatePlaceIOCOrders(orders, trader))
}


main()
// addMarginAgain()
// runAnalytics()
// juror()
// getAvailableMargin()
// placeIOCOrder()
// compareValues()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
