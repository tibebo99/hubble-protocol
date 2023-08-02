const { expect } = require('chai')
const { ethers } = require('hardhat')

const hubblev2next = require('../../../scripts/hubblev2next')
const config = hubblev2next.contracts

const {
    impersonateAccount,
    setupUpgradeableProxy,
    constants: { _1e18, ZERO, _1e6 },
    gotoNextFundingTime,
    setBalance,
} = require('../../utils')

const deployer = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d'
const governance = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d'
const maker = '0x93dAc05dE54C9d5ee5C59F77518F931168FDEC9b'
const taker = '0xCe743BFA1feaed060adBadfc8974be544b251Fe8'
const validator = '0x393bd9ac9dbBe75e84db739Bb15d22cA86D26696' // N. Virgina

describe.skip('hubblenext-rc.6 update', async function() {
    let blockNumber = 819750

    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: process.env.RPC_URL_ARCHIVE,
                    blockNumber
                }
            }]
        })

        ;([ orderBook, clearingHouse ] = await Promise.all([
            ethers.getContractAt('OrderBook', config.OrderBook),
            ethers.getContractAt('ClearingHouse', config.ClearingHouse),
        ]))

        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('deployer owns proxyAdmin', async function() {
        expect(await proxyAdmin.owner()).to.equal(deployer)
    })

    it('confirm proxyAdmin is indeed admin', async function() {
        for (let i = 0; i < config.amms.length; i++) {
            let admin = await ethers.provider.getStorageAt(config.amms[i].address, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
            admin = `0x${admin.slice(26).toLowerCase()}`
            // console.log(i, admin)
            expect(admin).to.equal(config.proxyAdmin.toLowerCase())
            expect(await proxyAdmin.getProxyAdmin(config.amms[i].address)).to.equal(config.proxyAdmin)
        }
        expect(await proxyAdmin.getProxyAdmin(config.ClearingHouse)).to.equal(config.proxyAdmin)
        expect(await proxyAdmin.getProxyAdmin(config.vusd)).to.equal(config.proxyAdmin)
    })

    it('deploy legacy oracle', async function() {
        const Oracle = await ethers.getContractFactory('TestOracle')
        oracle = await Oracle.connect(signer).deploy()
        console.log({ oracle: oracle.address })
        await proxyAdmin.connect(signer).upgrade(config.Oracle, oracle.address)
        oracle = await ethers.getContractAt('Oracle', config.Oracle)
    })

    it('deploy new oracle', async function() {
        const Oracle = await ethers.getContractFactory('NewOracle')
        newOracle = await Oracle.connect(signer).deploy()
        console.log({ newOracle: newOracle.address })
        await newOracle.connect(signer).setStablePrice(config.vusd, _1e6) // vusd
    })

    it('update amms', async function() {
        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.connect(signer).deploy(config.ClearingHouse)
        console.log({ newAMM: newAMM.address })

        // await impersonateAccount(config.ClearingHouse)
        // await gotoNextFundingTime(await ethers.getContractAt('AMM', config.amms[0].address))
        // await setBalance(config.ClearingHouse, _1e18.toHexString().replace(/0x0+/, "0x"))
        for (let i = 0; i < 10; i++) { // only eth and avax markets
            // console.log(i)
            const amm = await ethers.getContractAt('AMM', config.amms[i].address)
            await proxyAdmin.connect(signer).upgrade(config.amms[i].address, newAMM.address)
            if (i < 2) {
                // new oracle is not a proxy so aggregators need to be set again
                await newOracle.connect(signer).setAggregator(config.amms[i].underlying, config.amms[i].redStoneOracle)
                await amm.connect(signer).setOracleConfig(newOracle.address, '0x91661D7757C0ec1bdBb04D51b7a1039e30D6dcc9' /* adapter address */, config.amms[i].redStoneFeedId)
            }
            // console.log(await amm.getUnderlyingTwapPrice(3600))
            // console.log(await amm.getMarkPriceTwap())
            // await amm.connect(ethers.provider.getSigner(config.ClearingHouse)).settleFunding()
        }
    })

    it('deploy fee sink', async function() {
        feeSink = await setupUpgradeableProxy(
            'FeeSink',
            config.proxyAdmin,
            [ governance, governance /* treasury */ ],
            [ config.InsuranceFund, config.vusd, config.ClearingHouse ]
        )
        console.log({ feeSink: feeSink.address })
    })

    it('update CH/vusd', async function() {
        const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
        const newClearingHouse = await ClearingHouse.connect(signer).deploy()
        console.log({ newClearingHouse: newClearingHouse.address })

        const VUSD = await ethers.getContractFactory('VUSD')
        const newVUSD = await VUSD.connect(signer).deploy()
        console.log({ newVUSD: newVUSD.address })

        const tasks = []
        tasks.push(proxyAdmin.connect(signer).upgrade(config.ClearingHouse, newClearingHouse.address))
        tasks.push(proxyAdmin.connect(signer).upgrade(config.vusd, newVUSD.address))
        tasks.push(clearingHouse.connect(signer).setFeeSink(feeSink.address))

        const txs = await Promise.all(tasks)
        for (let i = 0; i < txs.length; i++) {
            const r = await txs[i].wait()
            // console.log(r)
            expect(r.status).to.equal(1)
        }
    })

    it('settleFunding', async function() {
        const amm = await ethers.getContractAt('AMM', config.amms[0].address)
        const oldFundingTime = await amm.nextFundingTime()

        await gotoNextFundingTime(amm)
        await impersonateAccount(validator)
        const tx = await orderBook.connect(ethers.provider.getSigner(validator)).settleFunding()
        const r = await tx.wait()
        const { events } = r
        const fundingRateUpdatedEvents = events.filter(e => {
            return e.address == config.ClearingHouse && clearingHouse.interface.parseLog(e).name == 'FundingRateUpdated'
        }).map(e => clearingHouse.interface.parseLog(e))

        expect(fundingRateUpdatedEvents.length).to.equal(10)
        console.log({
            // fundingRateUpdatedEvents,
            oldFundingTime: oldFundingTime.toString(),
            newFundingTime: (await amm.nextFundingTime()).toString(),
            gasUsed: r.gasUsed
        })
    })
})
