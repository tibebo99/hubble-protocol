const utils = require('../../test/utils')

const {
    constants: { _1e6, _1e18 },
    sleep,
    getTxOptions,
    setupUpgradeableProxy,
    verification
} = utils

const hubblev2next = require('../hubblev2next')
const { marketInfo } = hubblev2next

const { addMargin, initializeTxOptionsFor0thSigner, setupAMM, deployToken, getImplementationFromProxy, getAdminFromProxy } = require('../common')
const config = require('../hubblev2next').contracts
const { maker, taker, faucet } = hubblev2next.marketMaker

async function mintNative() {
    const nativeMinter = await ethers.getContractAt('INativeMinter', '0x0200000000000000000000000000000000000001')
    // await nativeMinter.setEnabled(taker)
    // await nativeMinter.setEnabled(faucet) // done during deploy
    await nativeMinter.mintNativeCoin(maker, _1e18.mul(688000))
    // await nativeMinter.mintNativeCoin(taker, _1e18.mul(105000))
}

async function depositMargin() {
    ;([, alice, bob] = await ethers.getSigners())
    const amount = _1e6.mul(1e5)
    await addMargin(alice, amount)
    await addMargin(bob, amount)

    await sleep(3)
    const marginAccount = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log({
        alice: await marginAccount.getAvailableMargin(alice.address),
        bob: await marginAccount.getAvailableMargin(bob.address),
    })
}

async function updateTestOracle() {
    // let _admin = await ethers.provider.getStorageAt(<address>, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
    // console.log(_admin)

    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    console.log({
        admin_at_slot: await getAdminFromProxy(oracle.address),
        admin_from_pa: await proxyAdmin.getProxyAdmin(oracle.address),
        impl_at_slot: await getImplementationFromProxy(oracle.address)
    })

    const TestOracle = await ethers.getContractFactory('TestOracle')
    const newImpl = await TestOracle.deploy()
    console.log({ newImpl: newImpl.address })

    await proxyAdmin.upgrade(oracle.address, newImpl.address)
    await sleep(3)
    console.log('newImpl', await getImplementationFromProxy(oracle.address))
}

async function whitelistValidators() {
    await initializeTxOptionsFor0thSigner()
    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0xaD6d1e84980a634b516f9558403a30445D614246'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x74E5490c066AeF921E205e5cb9Ac4A4eb693c2Cf'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4fA904477fd5cE9D26f29b9F61210aFC8DCA790a'), true, getTxOptions())
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x630Ee73BE56f5B712899a0d6893e76a802Ef5749'), true, getTxOptions())
}

async function setParams() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    console.log(await Promise.all([
        ch.maintenanceMargin(),
        ch.minAllowableMargin(),
        ch.takerFee(),
        ch.makerFee(),
        ch.referralShare(),
        ch.tradingFeeDiscount(),
        ch.liquidationPenalty(),
    ]))
    await ch.setParams(
        '100000', // 0.1
        '200000', // 0.2
        '500', // .05%
        '-50', // -0.005%
        '50',
        '100',
        '50000'
    )
}

async function setupNewAmms() {
    await initializeTxOptionsFor0thSigner()

    const toSetup = marketInfo.slice(3)
    const amms = []
    for (let i = 0; i < toSetup.length; i++) {
        const name = toSetup[i].name.slice(0, toSetup[i].name.length - 5)
        // console.log(`setting up ${name}`)
        const underlying = await deployToken(`hubblenet-${name}-tok`, `hubblenet-${name}-tok`, 18)
        const ammOptions = {
            governance,
            name: `${name}-Perp`,
            underlyingAddress: underlying.address,
            initialRate: toSetup[i].initialRate,
            oracleAddress: hubblev2next.contracts.Oracle,
            minSize: toSetup[i].minOrderSize,
            testAmm: false,
            whitelist: true
        }
        const { amm } = await setupAMM(ammOptions, false)
        amms.push({
            perp: `${name}-Perp`,
            address: amm.address,
            underlying: underlying.address,
        })
        console.log(amms)
    }
}

async function setupInitialRate() {
    await initializeTxOptionsFor0thSigner()

    const toSetup = marketInfo
    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    for (let i = 3; i < toSetup.length; i++) {
        let { name, initialRate } = toSetup[i]
        name = toSetup[i].name.slice(0, toSetup[i].name.length - 5)
        const underlyingAsset = hubblev2next.contracts.amms[i].underlying
        console.log(`setting up ${name}, ${initialRate}, ${underlyingAsset}`)
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }
}

async function setOracleUpdater() {
    await initializeTxOptionsFor0thSigner()
    const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
    await oracle.setUpdater('0xd6AF9F5b2ac25703b0c3B27e634991f554698E66', true, getTxOptions())
    await oracle.setUpdater('0x61583effe246022Bf1dca6cd2877A21C47b56474', true, getTxOptions())
}

async function getAmmsLength() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    console.log(await ch.getAmmsLength())
}

async function whitelistAmm() {
    await initializeTxOptionsFor0thSigner()
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    // const ob = await ethers.getContractAt('OrderBook', config.OrderBook)
    for (let i = 3; i < 10; i++) {
        const amm = await ethers.getContractAt('AMM', config.amms[i].address)
        // console.log({
        //     name: await amm.name(),
        //     oracle: await amm.oracle(),
        //     governance: await amm.governance(),
        //     nextFundingTime: await amm.nextFundingTime(),
        //     minSizeRequirement: utils.bnToFloat(await amm.minSizeRequirement(), 18)
        // })
        // console.log(await ob.minSizes(i))
        try {
            const tx = await ch.whitelistAmm(config.amms[i].address, getTxOptions())
            console.log(await tx.wait())
            // console.log('estiamte gas', await ch.estimateGas.whitelistAmm(config.amms[i].address))
        } catch(e) {
            console.log(e)
        }
    }
}

// same script utilized for both rc.1 and rc.3 upgrade
// 2.0.0-next.rc.1 update (use precompile for determining fill price)
// 2.0.0-next.rc.3 update (efficient data structures)
async function rc3Update() {
    await initializeTxOptionsFor0thSigner()

    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.ClearingHouse, getTxOptions())
    console.log({ newAMM: newAMM.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newClearingHouse = await ClearingHouse.deploy(getTxOptions())
    console.log({ newClearingHouse: newClearingHouse.address })

    const OrderBook = await ethers.getContractFactory('OrderBook')
    const newOrderBook = await OrderBook.deploy(config.ClearingHouse, config.MarginAccount, getTxOptions())
    console.log({ newOrderBook: newOrderBook.address })

    // Phase 2
    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    for (let i = 0; i < config.amms.length; i++) {
        tasks.push(proxyAdmin.upgrade(config.amms[i].address, newAMM.address, getTxOptions()))
    }
    tasks.push(proxyAdmin.upgrade(config.ClearingHouse, newClearingHouse.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.OrderBook, newOrderBook.address, getTxOptions()))
    await logStatus(tasks)
}

// 2.0.0-next.rc.2 update (red stone integration)
async function rc2Update() {
    const NewOracle = await ethers.getContractFactory('NewOracle')
    const newOracle = await NewOracle.deploy()
    console.log({ newOracle: newOracle.address })

    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.ClearingHouse)
    console.log({ newAMM: newAMM.address })

    // Phase 2
    await sleep(5)
    await initializeTxOptionsFor0thSigner()
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    for (let i = 0; i < 2; i++) { // only eth and avax markets
        tasks.push(newOracle.setAggregator(config.amms[i].underlying, config.amms[i].redStoneOracle, getTxOptions()))
        tasks.push(proxyAdmin.upgrade(config.amms[i].address, newAMM.address, getTxOptions()))
        const amm = await ethers.getContractAt('AMM', config.amms[i].address)
        tasks.push(amm.setOracleConfig(newOracle.address, '0x91661D7757C0ec1bdBb04D51b7a1039e30D6dcc9' /* adapter address */, config.amms[i].redStoneFeedId, getTxOptions()))
    }
    await logStatus(tasks)
}

async function logStatus(tasks) {
    console.log()
    const txs = await Promise.all(tasks)
    for (let i = 0; i < txs.length; i++) {
        const r = await txs[i].wait()
        console.log(`task=${i}, status=${r.status ? 'success' : 'fail'}`)
    }
}

// 2.0.0-next.rc.4 update (deploy ioc orderbook, new order format)
async function rc4Update() {
    await initializeTxOptionsFor0thSigner()

    const Juror = await ethers.getContractFactory('Juror')
    const deployArgs = [config.ClearingHouse, config.OrderBook, config.governance]
    juror = await Juror.deploy(...deployArgs, getTxOptions())
    console.log({ juror: juror.address }) // 0x0F6cB1B85E57cf124bb0Ea0B06101C83b0cCfe69 but this was moved to precompile
    verification.push({ name: 'Juror', address: juror.address, constructorArguments: deployArgs })

    proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    iocOrderBook = await setupUpgradeableProxy(
        'ImmediateOrCancelOrders',
        config.proxyAdmin,
        [ config.governance, config.OrderBook, juror.address ],
        []
    )
    console.log({ iocOrderBook: iocOrderBook.address }) // 0x635c5F96989a4226953FE6361f12B96c5d50289b
    console.log(verification)

    await rc3Update()

    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    console.log(await (await orderBook.setJuror(config.Juror)).wait())
    // console.log(await orderBook.juror())
    // console.log(await orderBook.bibliophile())

    const iocOrderBook = await ethers.getContractAt('ImmediateOrCancelOrders', config.IocOrderBook)
    console.log(await (await iocOrderBook.setJuror(config.Juror)).wait())
    console.log(await (await orderBook.setOrderHandler(1, iocOrderBook.address)).wait())
}

async function expiry() {
    const iocOrderBook = await ethers.getContractAt('ImmediateOrCancelOrders', config.IocOrderBook)
    await iocOrderBook.setExpirationCap(10)
    console.log(await iocOrderBook.expirationCap())
}

// 2.0.0-next.rc.5 update (hubble referral)
async function rc5Update() {
    await initializeTxOptionsFor0thSigner()

    const MinimalForwarder = await ethers.getContractFactory('contracts/MinimalForwarder.sol:MinimalForwarder')
    const forwarder = await MinimalForwarder.deploy(getTxOptions())
    console.log({ forwarder: forwarder.address }) // 0xF0978c72F6BfFac051735b0F01e63c55F7aE02d3

    const newHubbleReferral = await setupUpgradeableProxy(
        'HubbleReferral',
        config.proxyAdmin,
        [ config.governance ],
        [ forwarder.address, config.ClearingHouse]
    )
    console.log({ newHubbleReferral: newHubbleReferral.address }) // 0x27e1f032a8c24Cf7528247B02F085Eec9631CaeC

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newClearingHouse = await ClearingHouse.deploy(getTxOptions())
    console.log({ newClearingHouse: newClearingHouse.address }) // 0xd196cb1a48Aa0a979Ffc7780E8CE125c6B9CaD5d

    const OrderBook = await ethers.getContractFactory('OrderBook')
    const newOrderBook = await OrderBook.deploy(config.ClearingHouse, config.MarginAccount, getTxOptions())
    console.log({ newOrderBook: newOrderBook.address }) // 0xB3690FC3c0F8F80099144f6E27fc1B642A30cACB

    const ImmediateOrCancelOrders = await ethers.getContractFactory('ImmediateOrCancelOrders')
    const newIOCOrderBook = await ImmediateOrCancelOrders.deploy(getTxOptions())
    console.log({ newIOCOrderBook: newIOCOrderBook.address }) // 0xdf01E1C83db478b0e93990b330CcFfBCC048511a

    // Phase 2
    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    tasks.push(proxyAdmin.upgrade(config.ClearingHouse, newClearingHouse.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.OrderBook, newOrderBook.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.IocOrderBook, newIOCOrderBook.address, getTxOptions()))

    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    tasks.push(orderBook.setReferral(newHubbleReferral.address, getTxOptions()))

    const iocOrderBook = await ethers.getContractAt('ImmediateOrCancelOrders', config.IocOrderBook)
    tasks.push(iocOrderBook.setReferral(newHubbleReferral.address, getTxOptions()))

    const clearingHouse = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    tasks.push(clearingHouse.setReferral(newHubbleReferral.address, getTxOptions()))

    tasks.push(newHubbleReferral.beginSignups(20))
    await logStatus(tasks)
    console.log(verification)
}

// 2.0.0-next.rc.6 update (fee sink)
async function rc6Update() {
    await initializeTxOptionsFor0thSigner()

    const Oracle = await ethers.getContractFactory('TestOracle')
    const oracle = await Oracle.deploy(getTxOptions())
    console.log({ oracle: oracle.address })

    const NewOracle = await ethers.getContractFactory('NewOracle')
    const newOracle = await NewOracle.deploy(getTxOptions())
    console.log({ newOracle: newOracle.address })

    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.ClearingHouse, getTxOptions())
    console.log({ newAMM: newAMM.address })

    feeSink = await setupUpgradeableProxy(
        'FeeSink',
        config.proxyAdmin,
        [ config.governance, config.governance /* treasury */ ],
        [ config.InsuranceFund, config.vusd, config.ClearingHouse ]
    )
    console.log({ feeSink: feeSink.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newClearingHouse = await ClearingHouse.deploy(getTxOptions())
    console.log({ newClearingHouse: newClearingHouse.address })

    const VUSD = await ethers.getContractFactory('VUSD')
    const newVUSD = await VUSD.deploy(getTxOptions())
    console.log({ newVUSD: newVUSD.address })

    // Phase 2
    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    tasks.push(proxyAdmin.upgrade(config.Oracle, oracle.address, getTxOptions()))
    tasks.push(newOracle.setStablePrice(config.vusd, _1e6, getTxOptions())) // vusd
    for (let i = 0; i < config.amms.length; i++) {
        tasks.push(proxyAdmin.upgrade(config.amms[i].address, newAMM.address, getTxOptions()))
        if (i < 2) {
            // new oracle is not a proxy so aggregators need to be set again
            tasks.push(newOracle.setAggregator(config.amms[i].underlying, config.amms[i].redStoneOracle, getTxOptions()))
            const amm = await ethers.getContractAt('AMM', config.amms[i].address)
            tasks.push(amm.setOracleConfig(newOracle.address, '0x91661D7757C0ec1bdBb04D51b7a1039e30D6dcc9' /* adapter address */, config.amms[i].redStoneFeedId, getTxOptions()))
        }
    }
    tasks.push(proxyAdmin.upgrade(config.ClearingHouse, newClearingHouse.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.vusd, newVUSD.address, getTxOptions()))
    const clearingHouse = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    tasks.push(clearingHouse.setFeeSink(feeSink.address, getTxOptions()))
    await logStatus(tasks)
}

// 2.0.0-next.rc.7 update (cancelOrdersAtomic)
async function rc7Update() {
    await initializeTxOptionsFor0thSigner()

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newClearingHouse = await ClearingHouse.deploy(getTxOptions())
    console.log({ newClearingHouse: newClearingHouse.address }) // 0x4bbc4a4A38326aD0aE01C1cF7e936Ba3d0AeCeF4

    const MarginAccount = await ethers.getContractFactory('MarginAccount')
    const newMarginAccount = await MarginAccount.deploy(config.Forwarder, getTxOptions())
    console.log({ newMarginAccount: newMarginAccount.address }) // 0x634d1b90C25776482c28Af1Ff3edcB9D883090Ed

    const OrderBook = await ethers.getContractFactory('OrderBook')
    const newOrderBook = await OrderBook.deploy(config.ClearingHouse, config.MarginAccount, getTxOptions())
    console.log({ newOrderBook: newOrderBook.address }) // 0xC82ce8E2dfA142ff090bCbD6518F97E7b2f16024

    // Phase 2
    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    const tasks = []
    tasks.push(proxyAdmin.upgrade(config.ClearingHouse, newClearingHouse.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.MarginAccount, newMarginAccount.address, getTxOptions()))
    tasks.push(proxyAdmin.upgrade(config.OrderBook, newOrderBook.address, getTxOptions()))
    await logStatus(tasks)
}

// 2.0.0-next.rc.8 update marginAccountHelper and deploy bridge
async function rc8Update() {
    // update marginAccountHelper
    const MarginAccountHelper = await ethers.getContractFactory('MarginAccountHelper')
    const newMAHelper = await MarginAccountHelper.deploy()
    console.log({ newMAHelper: newMAHelper.address })

    await sleep(5)
    await initializeTxOptionsFor0thSigner()
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    await logStatus([proxyAdmin.upgrade(config.MarginAccountHelper, newMAHelper.address, getTxOptions())])

    // deploy hgt
    await sleep(5)
    const l0EndpointHubble = '0x8b14D287B4150Ff22Ac73DF8BE720e933f659abc'
    TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    hgt = await setupUpgradeableProxy(
        'HGT',
        config.proxyAdmin,
        [ governance /** signer[0] */, config.MarginAccountHelper ],
        [ l0EndpointHubble ]
    )
    console.log('hgt', hgt.address)

    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)
    await logStatus([marginAccountHelper.setHGT(hgt.address, getTxOptions())])
}

// 2.0.0-next.rc.8.1 update marginAccountHelper and trusted remote in hgt
async function rc8_1Update() {
    // update truted remote
    await setTrustedRemote()
    await sleep(5)
    // update marginAccountHelper
    const MarginAccountHelper = await ethers.getContractFactory('MarginAccountHelper')
    const newMAHelper = await MarginAccountHelper.deploy(getTxOptions())
    console.log({ newMAHelper: newMAHelper.address })

    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    await logStatus([proxyAdmin.upgrade(config.MarginAccountHelper, newMAHelper.address, getTxOptions())])
}

// 2.0.0-next.rc.8.2 update hgtRemote
async function rc8_2Update() {
    // update hgtRemote
    const HGTRemote = await ethers.getContractFactory('HGTRemote')
    const newHGTRemote = await HGTRemote.deploy(getTxOptions())
    console.log({ newHGTRemote: newHGTRemote.address })

    await sleep(5)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.fuji.ProxyAdmin)
    await logStatus([proxyAdmin.upgrade(config.fuji.HgtRemote, newHGTRemote.address, getTxOptions())])
}

// set trusted remote on the base chain
async function setTrustedRemote() {
    await initializeTxOptionsFor0thSigner()
    const hgt = await ethers.getContractAt('HGT', config.hgt)
    const l0ChainIdFuji = 10106
    await hgt.setTrustedRemote(
        l0ChainIdFuji,
        ethers.utils.solidityPack(['address', 'address'], [config.fuji.LzClient, hgt.address]),
        getTxOptions()
    )
}

async function feeConfig() {
    const feeConfig = await ethers.getContractAt('IFeeManager', '0x0200000000000000000000000000000000000003')
    const config = await feeConfig.getFeeConfig()
    console.log(config)
    await feeConfig.setFeeConfig(
        config.gasLimit,
        config.targetBlockRate,
        config.minBaseFee,
        config.targetGas,
        config.baseFeeChangeDenominator,
        config.minBlockGasCost,
        config.maxBlockGasCost,
        0
    )
    console.log(config)
}

feeConfig()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
