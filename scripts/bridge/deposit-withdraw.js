const config = require('../hubblev2next').contracts
const {
    buildDepositPayload
} = require('../../test/bridge/bridgeUtils')
const testAddress = '0x0Bd075cd25Bec44547251dAA87013851CEcd714E'
const usdcFuji = '0x4A0D1092E9df255cf95D72834Ea9255132782318' // usdc instance on fuji (stargate version)
const _1e6 = ethers.utils.parseUnits('1', 6)
const _1e18 = ethers.utils.parseUnits('1', 18)
const ZERO_ADDRESS = ethers.constants.AddressZero
const l0ChainIdFuji = 10106
const l0ChainIdHubble = 10182
const l0ChainIdArb = 10143
const l0ChainIdOPT = 10132
const l0ChainIdBSC = 10102
const stargateRouterFuji = '0x13093E05Eb890dfA6DacecBdE51d24DabAb2Faa1'
const stargateRouterArb = '0xb850873f4c993Ac2405A1AdD71F6ca5D4d4d6b4f'
const usdcArb = '0x6aAd876244E7A1Ad44Ec4824Ce813729E5B6C291'
const adapterParams = ethers.utils.solidityPack(
    ['uint16', 'uint'],
    [1, _1e6]
)

async function deposit() {
    const hgtRemote = await ethers.getContractAt('HGTRemote', config.fuji.HgtRemote)
    const depositAmount = _1e6.mul(10)
    const depositVars = {
        to: testAddress,
        tokenIdx: 0,
        amount: depositAmount,
        toGas: depositAmount.div(10),
        isInsuranceFund: false,
        refundAddress: testAddress,
        zroPaymentAddress: ZERO_ADDRESS,
        adapterParams: adapterParams,
    }
    const usdc = await ethers.getContractAt('IERC20', usdcFuji)
    const l0Fee = await hgtRemote.estimateSendFee(depositVars)
    let tx = await usdc.approve(hgtRemote.address, depositAmount)
    await tx.wait()
    console.log('l0Fee', l0Fee[0].toString(), depositAmount.toString())
    tx = await hgtRemote.deposit(depositVars, { value: l0Fee[0], gasLimit: 5e5 })
    console.log(await tx.wait())
}

async function withdraw() {
    const hgt = await ethers.getContractAt('HGT', config.hgt)
    console.log(await ethers.provider.getBalance(testAddress))
    const withdrawAmount = _1e18.mul(1)
    const withdrawVars = {
        dstChainId: l0ChainIdFuji,
        secondHopChainId: 0,
        dstPoolId: 0,
        to: testAddress,
        tokenIdx: 0,
        amount: withdrawAmount,
        amountMin: withdrawAmount,
        refundAddress: testAddress,
        zroPaymentAddress: ZERO_ADDRESS,
        adapterParams
    }
    const l0Fee = await hgt.estimateSendFee(withdrawVars)
    let tx = await hgt.withdraw(withdrawVars, { value: withdrawAmount.add(l0Fee[0]), gasLimit: 5e5 })
    console.log(await tx.wait())
}

async function deposit2Hops() {
    const stargateRouter = await ethers.getContractAt('IStargateRouter', stargateRouterArb)
    const usdc = await ethers.getContractAt('IERC20', usdcArb)
    const depositAmount = _1e6.mul(15) // 250 usdc
    let [ sgPayload,, ] = buildDepositPayload(
        testAddress, 0, depositAmount, depositAmount.div(2) /** toGas */, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
    )

    const dstGasForCall = 350000
    let l0Fee = await stargateRouter.quoteLayerZeroFee(
        l0ChainIdFuji,
        1, // function type: see Bridge.sol for all types
        ethers.utils.solidityPack(['address'], [ testAddress ]),
        sgPayload,
        { dstGasForCall, dstNativeAmount: 0, dstNativeAddr: '0x', }
    )

    console.log('l0Fee', l0Fee)
    const usdcBalBefore = await usdc.balanceOf(testAddress)
    console.log('usdcBalBefore', usdcBalBefore.toString())

    const depositAmountMin = depositAmount.sub(depositAmount.div(200)) // 0.5% slippage
    await usdc.approve(stargateRouter.address, depositAmount)
    const tx = await stargateRouter.swap(
        l0ChainIdFuji,
        1, // pool id
        1, // destPoolIdForUSDCAvax
        testAddress, // refund address
        depositAmount,
        depositAmountMin,
        { dstGasForCall, dstNativeAmount: 0, dstNativeAddr: '0x' },
        ethers.utils.solidityPack(['address'], [ config.fuji.HgtRemote ]), // the address to send the tokens to on the destination
        sgPayload,
        { value: l0Fee[0] }
    )

    console.log(await tx.wait())

    const usdcBalAfter = await usdc.balanceOf(testAddress)
    console.log('usdcBalAfter', usdcBalAfter.toString())
}

async function withdraw2Hops() {
    let withdrawAmount = _1e18.mul(10)
    const withdrawVars = {
        dstChainId: l0ChainIdFuji,
        secondHopChainId: l0ChainIdBSC,
        dstPoolId: 2,
        to: testAddress,
        tokenIdx: 0,
        amount: withdrawAmount,
        amountMin: amount.mul(95).div(100),
        refundAddress: testAddress,
        zroPaymentAddress: ZERO_ADDRESS,
        adapterParams
    }

    const hgt = await ethers.getContractAt('HGT', config.hgt)
    const l0Fee = await hgt.estimateSendFee(withdrawVars)
    let tx = await hgt.withdraw(withdrawVars, { value: withdrawAmount.add(l0Fee[0]), gasLimit: 5e5 })
    console.log(await tx.wait())
}

async function withdrawFromMargin(amount) {
    const withdrawVars = {
        dstChainId: l0ChainIdFuji,
        secondHopChainId: l0ChainIdBSC,
        dstPoolId: 2,
        to: testAddress,
        tokenIdx: 0,
        amount,
        amountMin: amount.mul(95).div(100), // amountMin - 5% slippage,
        refundAddress: testAddress,
        zroPaymentAddress: ZERO_ADDRESS,
        adapterParams
    }

    const hgt = await ethers.getContractAt('HGT', config.hgt)
    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)

    const l0Fee = await hgt.estimateSendFee(withdrawVars)
    let tx = await marginAccountHelper.withdrawMarginToChain(
        withdrawVars.to,
        withdrawVars.amount,
        withdrawVars.tokenIdx,
        withdrawVars.dstChainId,
        withdrawVars.secondHopChainId,
        withdrawVars.amountMin,
        withdrawVars.dstPoolId,
        withdrawVars.adapterParams,
        { gasLimit: 1e6, value: l0Fee[0] }
    )

    console.log(await tx.wait())
}

async function withdrawFromInsuranceFund(shares) {
    const insuranceFund = await ethers.getContractAt('InsuranceFund', config.InsuranceFund)
    const pricePerShare = await insuranceFund.pricePerShare()
    const amount = shares.mul(pricePerShare).div(_1e6)
    console.log({ amount, pricePerShare })
    const withdrawVars = {
        dstChainId: l0ChainIdFuji,
        secondHopChainId: l0ChainIdBSC,
        dstPoolId: 2,
        to: testAddress,
        tokenIdx: 0,
        amount,
        amountMin: amount.sub(_1e6.mul(2)),
        refundAddress: testAddress,
        zroPaymentAddress: ZERO_ADDRESS,
        adapterParams
    }

    const hgt = await ethers.getContractAt('HGT', config.hgt)
    const marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', config.MarginAccountHelper)

    const l0Fee = await hgt.estimateSendFee(withdrawVars)
    let tx = await marginAccountHelper.withdrawFromInsuranceFundToChain(
        withdrawVars.to,
        shares,
        withdrawVars.dstChainId,
        withdrawVars.secondHopChainId,
        withdrawVars.amountMin,
        withdrawVars.dstPoolId,
        withdrawVars.adapterParams,
        { gasLimit: 1e6, value: l0Fee[0] }
    )

    console.log(await tx.wait())
}

async function clearSgCache() {
    const stargateRouter = await ethers.getContractAt('IStargateRouter', stargateRouterFuji)
    // get srcAddress from cachedSwap event on fuji
    const srcAddress = ethers.utils.solidityPack(['address', 'address'], ['0xd43cbcc7642c1df8e986255228174c2cca58d65b', '0x29fBC4E4092Db862218c62a888a00F9521619230'])
    console.log(srcAddress)

    let tx = await stargateRouter.clearCachedSwap(l0ChainIdArb, srcAddress, 110)
    console.log(await tx.wait())
}

async function retryLzPayload() {
    const lzEndpointBase = await ethers.getContractAt('ILayerZeroEndpointModified', config.LzEndpoint)
    const srcAddress = ethers.utils.solidityPack(['address', 'address'], [config.fuji.HgtRemote, config.hgt])
    console.log(await lzEndpointBase.hasStoredPayload(l0ChainIdFuji, srcAddress))
    const events = await lzEndpointBase.queryFilter('PayloadStored', 807820)
    const payload = events[0].args.payload
    console.log(payload)
    let tx = await lzEndpointBase.retryPayload(l0ChainIdFuji, srcAddress, payload)
    console.log(await tx.wait())
}

async function rescueMyFunds() {
    const hgtRemote = await ethers.getContractAt('HGTRemote', config.fuji.HgtRemote)
    const funds = await hgtRemote.rescueFunds(usdcFuji, testAddress)
    console.log(funds)
    await hgtRemote.rescueMyFunds(usdcFuji, funds)
}

async function rescueWithdrawFunds(txHash) {
    let tx = await ethers.provider.getTransaction(txHash)
    const lzClient = await ethers.getContractAt('LZClient', config.fuji.LzClient)
    const { logs } = await tx.wait()
    const failedEvent = lzClient.interface.parseLog(logs.pop())
    const hgtRemote = await ethers.getContractAt('HGTRemote', config.fuji.HgtRemote)
    tx = await hgtRemote.rescueWithdrawFunds(
        failedEvent.args._srcChainId,
        failedEvent.args._srcAddress,
        failedEvent.args._nonce,
        failedEvent.args._payload
    )
    console.log(await tx.wait())
}

withdrawFromInsuranceFund(_1e6.mul(10))
