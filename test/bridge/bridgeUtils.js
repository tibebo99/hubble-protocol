const { ethers } = require('hardhat')
const utils = require('../utils')

const cchainId = 43114
const hubbleChainId = 54321

const ZERO_ADDRESS = ethers.constants.AddressZero
const usdcAvax = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const priceFeedAvaxToUSD = '0x0A77230d17318075983913bC2145DB16C7366156' // from Chainkink avax net
const priceFeedUSDCToUSD = '0xF096872672F44d6EBA71458D74fe67F9a77a23B9'
const stargateRouterAvax = '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd'
const stargatePoolIdUSDC = 1


async function setupAvaxContracts(proxyAdmin, marginAccountHelper, options = {}) {
    options = Object.assign(
        {
            governance: signers[0].address
        },
        options
    )

    ;([
        LZEndpointMockFactory,
        usdcAvaxInstance,
        avaxPriceFeed,
        usdcPriceFeed,
        LZClient,
    ] = await Promise.all([
        ethers.getContractFactory('TestLZEndpointMock'),
        ethers.getContractAt('IERC20', usdcAvax),
        ethers.getContractAt('AggregatorV3Interface', priceFeedAvaxToUSD),
        ethers.getContractAt('AggregatorV3Interface', priceFeedUSDCToUSD),
        ethers.getContractFactory('LZClient'),
    ]))

    lzEndpointMockRemote = await LZEndpointMockFactory.deploy(cchainId)
    lzEndpointMockBase = await LZEndpointMockFactory.deploy(hubbleChainId)

    hgtRemote = await utils.setupUpgradeableProxy(
        'HGTRemote',
        proxyAdmin,
        [ options.governance, stargateRouterAvax, {
            token: usdcAvax,
            priceFeed: priceFeedUSDCToUSD,
            collectedFee: 0,
            srcPoolId: stargatePoolIdUSDC,
            decimals: 6,
        },
        priceFeedAvaxToUSD ]
    )

    lzClient = await LZClient.deploy(lzEndpointMockRemote.address, hgtRemote.address, hubbleChainId, options.governance)
    await hgtRemote.setLZClient(lzClient.address)

    hgt = await utils.setupUpgradeableProxy(
        'HGT',
        proxyAdmin,
        [ options.governance, marginAccountHelper ],
        [ lzEndpointMockBase.address ]
    )

    const _marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', marginAccountHelper)
    await _marginAccountHelper.setHGT(hgt.address)

    // internal bookkeeping for endpoints (not part of a real deploy, just for this test)
    await lzEndpointMockRemote.setDestLzEndpoint(hgt.address, lzEndpointMockBase.address)
    await lzEndpointMockBase.setDestLzEndpoint(lzClient.address, lzEndpointMockRemote.address)

    await lzClient.setTrustedRemote(
        hubbleChainId,
        ethers.utils.solidityPack(['address', 'address'], [hgt.address, lzClient.address])
    )
    await hgt.setTrustedRemote(
        cchainId,
        ethers.utils.solidityPack(['address', 'address'], [lzClient.address, hgt.address])
    )

    res = {
        usdcAvaxInstance,
        hgtRemote,
        hgt,
        lzClient,
        avaxPriceFeed,
        usdcPriceFeed,
        lzEndpointMockRemote,
        lzEndpointMockBase
    }
    return res
}

function buildDepositPayload(to, tokenIdx, amount, toGas, isInsuranceFund, zroPaymentAddress, adapterParams) {
    const abi = ethers.utils.defaultAbiCoder
    const sgPayload = abi.encode(
        [ 'address', 'uint256', 'uint256', 'uint256', 'bool', 'address', 'bytes' ],
        [ to, tokenIdx, amount, toGas, isInsuranceFund, zroPaymentAddress, adapterParams ]
    )

    const metadata = abi.encode([ 'uint256', 'bool' ], [ toGas, isInsuranceFund ])
    const lzPayload = abi.encode(
        [ 'uint256', 'address', 'uint256', 'uint256', 'bytes' ],
        [ 1 /**PT_SEND */, to, tokenIdx, amount, metadata ]
    )
    return [ sgPayload, lzPayload, metadata ]
}

function buildWithdrawPayload(withdrawVars) {
    const abi = ethers.utils.defaultAbiCoder
    const lzPayload = abi.encode(
        [ 'uint256', 'address', 'uint256', 'uint256', 'uint16', 'uint256', 'uint256' ],
        [ 1 /**PT_SEND */, withdrawVars.to, withdrawVars.tokenIdx, withdrawVars.amount, withdrawVars.secondHopChainId, withdrawVars.amountMin, withdrawVars.dstPoolId ]
    )
    return lzPayload
}

module.exports = {
    setupAvaxContracts,
    buildDepositPayload,
    buildWithdrawPayload,
    hubbleChainId,
    cchainId,
    ZERO_ADDRESS,
}
