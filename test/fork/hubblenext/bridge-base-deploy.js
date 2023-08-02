const { expect } = require('chai')
const { ethers } = require('hardhat')

const hubblev2next = require('../../../scripts/hubblev2next')
const config = hubblev2next.contracts
const { buildDepositPayload, ZERO_ADDRESS } = require('../../bridge/bridgeUtils')

const {
    impersonateAccount,
    setupUpgradeableProxy,
    setBalance,
    constants: { _1e6, _1e12, _1e18 }
} = require('../../utils')

const deployer = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d' // governance
const l0EndpointHubble = '0x8b14D287B4150Ff22Ac73DF8BE720e933f659abc'
const l0ChainIdFuji = 10106
const lzClientAddress = '0x3c2269811836af69497E5F486A85D7316753cf62' // place holder address for lzClient

describe('deploy hgt on hubbleNet', async function() {
    let blockNumber = 806780

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
        signers = await ethers.getSigners()
        ;[ alice ] = signers.map((s) => s.address)

        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)
        marginAccount = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('update marginAccountHelper', async function() {
        const MarginAccountHelper = await ethers.getContractFactory('MarginAccountHelper')
        const newMAHelper = await MarginAccountHelper.deploy()
        const proxyAdmin = await ethers.getContractAt('ProxyAdmin', config.proxyAdmin)
        await proxyAdmin.connect(signer).upgrade(config.MarginAccountHelper, newMAHelper.address)
        expect(await marginAccountHelper.insuranceFund()).to.equal(config.InsuranceFund)
        expect(await marginAccountHelper.marginAccount()).to.equal(config.MarginAccount)
        expect(await marginAccountHelper.vusd()).to.equal(config.vusd)
    })

    it('deploy hgt and set to maHelper', async function() {
        TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
        hgt = await setupUpgradeableProxy(
            'HGT',
            config.proxyAdmin,
            [ deployer /** governance */, config.MarginAccountHelper ],
            [ l0EndpointHubble ]
        )

        await marginAccountHelper.connect(signer).setHGT(hgt.address)

        packedTrustedRemote = ethers.utils.solidityPack(['address', 'address'], [lzClientAddress, hgt.address])
        await hgt.connect(signer).setTrustedRemote(
            l0ChainIdFuji,
            packedTrustedRemote
        )
        expect(await marginAccountHelper.hgt()).to.equal(hgt.address)
        expect(await hgt.marginAccountHelper()).to.equal(config.MarginAccountHelper)
        expect(await hgt.lzEndpoint()).to.equal(l0EndpointHubble)
        expect(await hgt.marginAccount()).to.equal(config.MarginAccount)
        expect(await hgt.getSupportedTokens()).to.have.lengthOf(1)
    })

    it('test deposit', async function() {
        // deposit address
        const bob = ethers.Wallet.createRandom().address
        // fund hgt and lzEndpoint
        hgtBalance = ethers.utils.hexStripZeros(_1e18.mul(_1e6)) // 1m
        await setBalance(hgt.address, hgtBalance)
        await setBalance(l0EndpointHubble, ethers.utils.hexStripZeros(_1e18.mul(100)))

        const depositAmount = _1e6.mul(1000) // 1000 usdc

        const adapterParams = ethers.utils.solidityPack(
            ['uint16', 'uint'],
            [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
        )
        const toGas = depositAmount.div(2)

        let [ , lzPayload ] = buildDepositPayload(
            bob, 0, depositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
        )

        // simulate message received from lzEndpoint to hgt
        const lzEndpoint = await ethers.provider.getSigner(l0EndpointHubble)
        impersonateAccount(l0EndpointHubble)
        await hgt.connect(lzEndpoint).lzReceive(l0ChainIdFuji, packedTrustedRemote, 1, lzPayload)
        expect(await marginAccount.margin(0, bob)).to.equal(depositAmount.sub(toGas))
        expect(await ethers.provider.getBalance(bob)).to.equal(toGas.mul(_1e12))
    })
})
