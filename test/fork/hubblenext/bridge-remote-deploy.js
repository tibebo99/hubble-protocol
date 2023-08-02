const { expect } = require('chai')
const { ethers } = require('hardhat')
const { BigNumber } = require('ethers')

const {
    impersonateAccount,
    setupUpgradeableProxy,
    stopImpersonateAccount,
    setBalance,
    forkFuji,
    constants: { _1e6, _1e12, _1e18 }
} = require('../../utils')

const { buildDepositPayload, ZERO_ADDRESS } = require('../../bridge/bridgeUtils')

const deployer = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d' // governance
const l0EndpointFuji = '0x93f54D755A063cE7bB9e6Ac47Eccc8e33411d706'
const l0ChainIdHubble = 10182 // not the actual hubble chain id, used only for layer0 (uint16)
const stargateRouterFuji = '0x13093E05Eb890dfA6DacecBdE51d24DabAb2Faa1'
const stargatePoolIdUSDC = 1
const usdcFuji = '0x4A0D1092E9df255cf95D72834Ea9255132782318' // usdc instance on fuji (stargate version)
const priceFeedAvaxToUSD = '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD'
const priceFeedUSDCToUSD = '0x7898AcCC83587C3C55116c5230C17a6Cd9C71bad' // chainlink usdc price feed not available on fuji, using USDT instead
const USDCRichAddressFuji = '0xcf846b002f771fbdf6caa88913005a6424d480cc'
const l0ChainIdArbGoerli = 10143

describe('deploy hgtRemote on cchain', async function() {
    let blockNumber = 24367469

    before(async function() {
        await forkFuji(blockNumber)
        await impersonateAccount(deployer)
        signers = await ethers.getSigners()
        ;[ alice, bob ] = signers.map((s) => s.address)

        signer = ethers.provider.getSigner(deployer)
        ;([
            lzEndpointFuji,
            usdcFujiInstance,
            avaxPriceFeed,
            usdcPriceFeed,
        ] = await Promise.all([
            ethers.getContractAt('ILayerZeroEndpoint', l0EndpointFuji),
            ethers.getContractAt('IERC20', usdcFuji),
            ethers.getContractAt('AggregatorV3Interface', priceFeedAvaxToUSD),
            ethers.getContractAt('AggregatorV3Interface', priceFeedUSDCToUSD),
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('deploy hgtRemote', async function() {
        // deploy proxyAdmin on fuji
        const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')
        proxyAdmin = await ProxyAdmin.deploy()
        // console.log('proxyAdmin', proxyAdmin.address)

        TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
        hgtRemote = await setupUpgradeableProxy(
            'HGTRemote',
            proxyAdmin.address,
            [ deployer /** governance */, stargateRouterFuji, {
                token: usdcFuji,
                priceFeed: priceFeedUSDCToUSD,
                collectedFee: 0,
                srcPoolId: stargatePoolIdUSDC,
                decimals: 6,
            },
            priceFeedAvaxToUSD ]
        )

        LZClient = await ethers.getContractFactory('LZClient')
        lzClient = await LZClient.deploy(l0EndpointFuji, hgtRemote.address, l0ChainIdHubble, deployer)
        await hgtRemote.connect(signer).setLZClient(lzClient.address)

        // set trusted remote, using placeholder address for hgt
        await lzClient.connect(signer).setTrustedRemote(
            l0ChainIdHubble,
            ethers.utils.solidityPack(['address', 'address'], [alice, lzClient.address])
        )

        // console.log('hgtRemote', hgtRemote.address)
        expect(await hgtRemote.stargateRouter()).to.equal(stargateRouterFuji)
        expect(await hgtRemote.whitelistedRelayer(stargateRouterFuji)).to.equal(true)
        expect(await lzClient.lzEndpoint()).to.equal(l0EndpointFuji)
        expect(await hgtRemote.nativeTokenPriceFeed()).to.equal(priceFeedAvaxToUSD)
        const token = await hgtRemote.supportedTokens(0)
        expect(token.token).to.equal(usdcFuji)
        expect(token.priceFeed).to.equal(priceFeedUSDCToUSD)
        expect(token.collectedFee).to.equal(0)
        expect(token.srcPoolId).to.equal(stargatePoolIdUSDC)
        expect(token.decimals).to.equal(6)

        expect(await lzClient.hubbleL0ChainId()).to.equal(l0ChainIdHubble)
        expect(await lzClient.hgtRemote()).to.equal(hgtRemote.address)
    })

    it('test deposit', async function() {
        // fund hgtRemote and stargateRouter with 100 avax to pay for gas
        hgtRemoteBalance = ethers.utils.hexStripZeros(_1e18.mul(100))
        await setBalance(hgtRemote.address, hgtRemoteBalance)
        await setBalance(stargateRouterFuji, hgtRemoteBalance)

        depositAmount = _1e6.mul(1000) // 1000 usdc
        // simulate funds received from stargate to hgtRemote
        usdcWhale = await ethers.provider.getSigner(USDCRichAddressFuji)
        await impersonateAccount(USDCRichAddressFuji)
        await usdcFujiInstance.connect(usdcWhale).transfer( hgtRemote.address, depositAmount)
        await stopImpersonateAccount(USDCRichAddressFuji)

        adapterParams = ethers.utils.solidityPack(
            ['uint16', 'uint'],
            [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
        )
        const toGas = depositAmount.div(2)

        let [ sgPayload, lzPayload ] = buildDepositPayload(
            bob, 0, depositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
        )

        const nativeFee = await lzEndpointFuji.estimateFees(l0ChainIdHubble, hgtRemote.address, lzPayload, false, adapterParams)

        // get avax and usdc price
        let latestAnswer = await avaxPriceFeed.latestRoundData()
        const avaxPrice = latestAnswer[1].div(100)
        latestAnswer = await usdcPriceFeed.latestRoundData()
        const usdcPrice = latestAnswer[1].div(100)
        const l0Fee = nativeFee[0].mul(avaxPrice).div(usdcPrice).div(_1e12)
        actualDepositAmount = depositAmount.sub(l0Fee)

        ;([, lzPayload, metadata] = buildDepositPayload(
            bob, 0, actualDepositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
        ))

        const stargateRouter = await ethers.provider.getSigner(stargateRouterFuji)
        impersonateAccount(stargateRouterFuji)
        await expect(
            hgtRemote.connect(stargateRouter).sgReceive(
                l0ChainIdArbGoerli,
                ZERO_ADDRESS, // not used
                1,
                usdcFujiInstance.address,
                depositAmount,
                sgPayload
            )
        )
        .to.emit(hgtRemote, 'StargateDepositProcessed').withArgs(l0ChainIdArbGoerli, 1, 0, depositAmount, sgPayload)
        .to.emit(hgtRemote, 'SendToChain').withArgs(l0ChainIdHubble, 1, lzPayload)
    })
})
