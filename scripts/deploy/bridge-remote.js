const { ethers } = require('hardhat')
const utils = require('../../test/utils')
const { initializeTxOptionsFor0thSigner } = require('../common')
const config = require('../hubblev2next').contracts

const l0EndpointFuji = '0x93f54D755A063cE7bB9e6Ac47Eccc8e33411d706'
const l0ChainIdHubble = 10182 // not the actual hubble chain id, used only for layer0 (uint16)
const stargateRouterFuji = '0x13093E05Eb890dfA6DacecBdE51d24DabAb2Faa1'
const stargatePoolIdUSDC = 1
const usdcFuji = '0x4A0D1092E9df255cf95D72834Ea9255132782318' // usdc instance on fuji
const priceFeedAvaxToUSD = '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD'
const priceFeedUSDCToUSD = '0x7898AcCC83587C3C55116c5230C17a6Cd9C71bad' // chainlink usdc price feed not available on fuji, using USDT instead

async function main(options = {}) {
    // governance = signers[0].address
    await initializeTxOptionsFor0thSigner()
    utils.txOptions.gasLimit = 6000000

    if (options.proxyAdmin) {
        proxyAdmin = await ethers.getContractAt('ProxyAdmin', options.proxyAdmin)
    } else {
        const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')
        proxyAdmin = await ProxyAdmin.deploy(utils.getTxOptions())
        console.log('proxyAdmin', proxyAdmin.address)
    }

    TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    hgtRemote = await utils.setupUpgradeableProxy(
        'HGTRemote',
        proxyAdmin.address,
        [ governance, stargateRouterFuji, {
            token: usdcFuji,
            priceFeed: priceFeedUSDCToUSD,
            collectedFee: 0,
            srcPoolId: stargatePoolIdUSDC,
            decimals: 6,
        },
        priceFeedAvaxToUSD ]
    )

    console.log('hgtRemote', hgtRemote.address)

    const LZClient = await ethers.getContractFactory('LZClient')
    const lzClient = await LZClient.deploy(l0EndpointFuji, hgtRemote.address, l0ChainIdHubble, governance, utils.getTxOptions())
    await hgtRemote.setLZClient(lzClient.address, utils.getTxOptions())

    console.log('lzClient', lzClient.address)

    // Next steps:
    // 1. set trusted remote
    // 2. add funds to hgtRemote
    // hgt address should be there in the config
    await lzClient.setTrustedRemote(
        l0ChainIdHubble,
        ethers.utils.solidityPack(['address', 'address'], [config.hgt, lzClient.address]),
        utils.getTxOptions()
    )
}

main({proxyAdmin: config.fuji.ProxyAdmin})
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
