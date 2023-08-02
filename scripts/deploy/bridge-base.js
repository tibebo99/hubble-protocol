const { ethers } = require('hardhat')
const utils = require('../../test/utils')
const config = require('../hubblev2next').contracts
const { initializeTxOptionsFor0thSigner } = require('../common')
const l0EndpointHubble = '0x8b14D287B4150Ff22Ac73DF8BE720e933f659abc'

async function main() {
    // governance = signers[0].address
    await initializeTxOptionsFor0thSigner()

    TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    hgt = await utils.setupUpgradeableProxy(
        'HGT',
        config.proxyAdmin,
        [ governance, config.MarginAccountHelper ],
        [ l0EndpointHubble ]
    )

    // only governace call
    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)
    await marginAccountHelper.setHGT(hgt.address, utils.getTxOptions())

    console.log('hgt', hgt.address)
    // Next steps:
    // 1. set trusted remote after deploying hgtRemote
    // 2. add funds to hgt
    // await hgt.setTrustedRemote(
    //     l0ChainIdCchain,
    //     ethers.utils.solidityPack(['address', 'address'], [hgtRemote.address, hgt.address])
    // )
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
