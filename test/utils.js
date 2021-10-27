const { expect } = require('chai')
const fs = require('fs')
const { BigNumber } = require('ethers')

const _1e6 = BigNumber.from(10).pow(6)
const _1e12 = BigNumber.from(10).pow(12)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */

function log(position, notionalPosition, unrealizedPnl, marginFraction) {
    console.log({
        size: position.size.toString(),
        openNotional: position.openNotional.toString(),
        notionalPosition: notionalPosition.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        marginFraction: marginFraction.toString()
    })
}

async function setupContracts(tradeFee = DEFAULT_TRADE_FEE) {
    governance = alice

    // Vyper
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    moonMath = await MoonMath.deploy()
    views = await Views.deploy(moonMath.address)

    // vyper deployment complete
    ;([ MarginAccountHelper, Registry, ERC20Mintable, MinimalForwarder, TransparentUpgradeableProxy, ProxyAdmin ] = await Promise.all([
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('ERC20Mintable'),
        ethers.getContractFactory('MinimalForwarder'),
        ethers.getContractFactory('TransparentUpgradeableProxy'),
        ethers.getContractFactory('ProxyAdmin')
    ]))

    ;([ proxyAdmin, usdc, weth ] = await Promise.all([
        ProxyAdmin.deploy(),
        ERC20Mintable.deploy('USD Coin', 'USDC', 6),
        ERC20Mintable.deploy('WETH', 'WETH', 18)
    ]))

    const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])

    oracle = await setupUpgradeableProxy('TestOracle', proxyAdmin.address, [ governance ])
    await oracle.setStablePrice(vusd.address, 1e6) // $1

    forwarder = await MinimalForwarder.deploy()
    await forwarder.intialize()

    marginAccount = await setupUpgradeableProxy('MarginAccount', proxyAdmin.address, [ forwarder.address, governance, vusd.address ])
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])

    clearingHouse = await setupUpgradeableProxy(
        'ClearingHouse',
        proxyAdmin.address,
        [
            forwarder.address,
            governance,
            insuranceFund.address,
            marginAccount.address,
            vusd.address,
            0.1 * 1e6 /* 10% maintenance margin */,
            tradeFee,
            0.05 * 1e6, // liquidationPenalty = 5%])
        ]
    )
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)

    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)

    ;({ amm, vamm } = await setupAmm(
        governance,
        [ registry.address, weth.address, 'ETH-Perp' ],
        1000, // initialRate,
        1000 // initialLiquidity
    ))
    await Promise.all([
        marginAccount.syncDeps(registry.address, 5e4), // liquidationIncentive = 5% = .05 scaled 6 decimals
        insuranceFund.syncDeps(registry.address)
    ])
    return {
        swap: vamm,
        amm,
        registry,
        marginAccount,
        marginAccountHelper,
        clearingHouse,
        vusd,
        usdc,
        weth,
        oracle,
        insuranceFund,
        forwarder,
        tradeFee
    }
}

async function setupUpgradeableProxy(contract, admin, initArgs, deployArgs) {
    const factory = await ethers.getContractFactory(contract)
    let impl
    if (deployArgs) {
        impl = await factory.deploy(...deployArgs)
    } else {
        impl = await factory.deploy()
    }
    const proxy = await TransparentUpgradeableProxy.deploy(
        impl.address,
        admin,
        initArgs
            ? impl.interface.encodeFunctionData(
                contract === 'InsuranceFund' || contract === 'VUSD' ? 'init' : 'initialize',
                initArgs
            )
            : '0x'
    )
    return ethers.getContractAt(contract, proxy.address)
}

async function setupAmm(governance, args, initialRate, initialLiquidity, _pause = false) {
    const vamm = await Swap.deploy(
        governance, // owner
        moonMath.address, // math
        views.address, // views
        54000, // A
        '3500000000000000', // gamma
        0, 0, 0, 0, // mid_fee, out_fee, allowed_extra_profit, fee_gamma
        '490000000000000', // adjustment_step
        0, // admin_fee
        600, // ma_half_time
        [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(initialRate)]
    )
    const amm = await setupUpgradeableProxy('AMM', proxyAdmin.address, args.concat([ vamm.address, governance ]))
    if (!_pause) {
        await amm.togglePause(_pause)
    }
    await vamm.setAMM(amm.address)

    initialLiquidity = _1e18.mul(initialLiquidity)
    await vamm.add_liquidity([
        initialLiquidity.mul(initialRate), // USD
        _1e6.mul(100).mul(25), // 25 btc - value not used
        initialLiquidity
    ], 0)
    await clearingHouse.whitelistAmm(amm.address)
    return { amm, vamm }
}

async function filterEvent(tx, name) {
    const { events } = await tx.wait()
    return events.find(e => e.event == name)
}

async function getTradeDetails(tx, tradeFee = DEFAULT_TRADE_FEE) {
    const positionModifiedEvent = await filterEvent(tx, 'PositionModified')
    return {
        quoteAsset: positionModifiedEvent.args.quoteAsset,
        fee: positionModifiedEvent.args.quoteAsset.mul(tradeFee).div(_1e6)
    }
}

async function parseRawEvent(tx, emitter, name) {
    const { events } = await tx.wait()
    const event = events.find(e => {
        if (e.address == emitter.address) {
            return emitter.interface.parseLog(e).name == name
        }
        return false
    })
    return emitter.interface.parseLog(event)
}

async function assertions(contracts, trader, vals, shouldLog) {
    const { amm, clearingHouse, marginAccount } = contracts
    const [ position, { notionalPosition, unrealizedPnl }, marginFraction, margin ] = await Promise.all([
        amm.positions(trader),
        amm.getNotionalPositionAndUnrealizedPnl(trader),
        clearingHouse.getMarginFraction(trader),
        marginAccount.getNormalizedMargin(trader)
    ])

    if (shouldLog) {
        log(position, notionalPosition, unrealizedPnl, marginFraction)
    }

    if (vals.size != null) {
        expect(position.size).to.eq(vals.size)
    }
    if (vals.openNotional != null) {
        expect(position.openNotional).to.eq(vals.openNotional)
    }
    if (vals.notionalPosition != null) {
        expect(notionalPosition).to.eq(vals.notionalPosition)
    }
    if (vals.unrealizedPnl != null) {
        expect(unrealizedPnl).to.eq(vals.unrealizedPnl)
    }
    if (vals.margin != null) {
        expect(margin).to.eq(vals.margin)
    }
    if (vals.marginFractionNumerator != null) {
        expect(marginFraction).to.eq(vals.marginFractionNumerator.mul(_1e6).div(notionalPosition))
    }
    if (vals.marginFraction != null) {
        expect(marginFraction).to.eq(vals.marginFraction)
    }

    return { position, notionalPosition, unrealizedPnl, marginFraction }
}

async function getTwapPrice(amm, intervalInSeconds, blockTimestamp) {
    const len = await amm.getSnapshotLen()
    let snapshotIndex = len.sub(1)
    let currentSnapshot = await amm.reserveSnapshots(snapshotIndex)
    let currentPrice = currentSnapshot.quoteAssetReserve.mul(_1e6).div(currentSnapshot.baseAssetReserve)
    const baseTimestamp = blockTimestamp - intervalInSeconds
    let previousTimestamp = currentSnapshot.timestamp
    if (intervalInSeconds == 0 || len == 1 || previousTimestamp <= baseTimestamp) {
        return currentPrice
    }
    let period = BigNumber.from(blockTimestamp).sub(previousTimestamp)
    let weightedPrice = currentPrice.mul(period)
    let timeFraction = 0
    while (true) {
        if (snapshotIndex == 0) {
            return weightedPrice.div(period)
        }
        snapshotIndex = snapshotIndex.sub(1)
        currentSnapshot = await amm.reserveSnapshots(snapshotIndex)
        currentPrice = currentSnapshot.quoteAssetReserve.mul(_1e6).div(currentSnapshot.baseAssetReserve)
        if (currentSnapshot.timestamp <= baseTimestamp) {
            weightedPrice = weightedPrice.add(currentPrice.mul(previousTimestamp.sub(baseTimestamp)))
            break
        }
        timeFraction = previousTimestamp.sub(currentSnapshot.timestamp)
        weightedPrice = weightedPrice.add(currentPrice.mul(timeFraction))
        period = period.add(timeFraction)
        previousTimestamp = currentSnapshot.timestamp
    }
    return weightedPrice.div(intervalInSeconds);
}

async function impersonateAcccount(address) {
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [address],
    });
}

async function stopImpersonateAcccount(address) {
    await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [address],
    });
}

async function gotoNextFundingTime(amm) {
    // @todo check that blockTimeStamp is not already > nextFundingTime
    return network.provider.send('evm_setNextBlockTimestamp', [(await amm.nextFundingTime()).toNumber()]);
}

function forkNetwork(_network, blockNumber) {
    return network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: `https://eth-${_network}.alchemyapi.io/v2/${process.env.ALCHEMY}`,
                blockNumber
            }
        }]
    })
}

async function signTransaction(signer, to, data, forwarder, value = 0, gas = 1000000) {
    const types = {
        ForwardRequest: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'gas', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ],
    }

    const domain = {
        name: 'MinimalForwarder',
        version: '0.0.1',
        chainId: await web3.eth.getChainId(),
        verifyingContract: forwarder.address,
    }

    const req = {
        from: signer.address,
        to: to.address,
        value,
        gas,
        nonce: (await forwarder.getNonce(signer.address)).toString(),
        data
    };
    const sign = await signer._signTypedData(domain, types, req)
    return { sign, req }
}

module.exports = {
    constants: { _1e6, _1e12, _1e18, ZERO },
    log,
    setupContracts,
    setupUpgradeableProxy,
    filterEvent,
    getTradeDetails,
    assertions,
    getTwapPrice,
    impersonateAcccount,
    stopImpersonateAcccount,
    gotoNextFundingTime,
    forkNetwork,
    setupAmm,
    signTransaction,
    parseRawEvent
}
