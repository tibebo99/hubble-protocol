const { expect } = require('chai')
const { ethers } = require('hardhat')
const { BigNumber } = require('ethers')
const utils = require('../utils')

const lzChainIdForEthMainnet = 101
const lzChainIdForCchain = 106
const srcPoolIdForUSDCMainnet = 1
const avaxForkBlock = 32461637
const ethForkBlock = 17675415
const { constants: { _1e6, _1e12, _1e18, ZERO } } = utils

const {
    setupAvaxContracts,
    buildDepositPayload,
    hubbleChainId,
    cchainId,
    ZERO_ADDRESS,
} = require('./bridgeUtils')

const MainnetStargateRouter = '0x8731d54E9D02c286767d56ac03e8037C07e01e98'
const MainnetStargateUSDCPool = '0xdf0770dF86a8034b3EFEf0A1Bb3c889B8332FF56'
const UsdcMainnet = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const UsdcWhaleMainnet = '0x79E2Ba942B0e8fDB6ff3d406e930289d10B49ADe' // for impersonate
const ETHStargateBridge = '0x296f55f8fb28e498b858d0bcda06d955b2cb3f97'

const emptyAddressCchain = '0x19ae07eEc761427c8659cc5E62bd8673b39aEaf5' // 0 token balance
const USDCRichAddressAvax = '0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9'


describe('Multi-chain Deposits', async function () {

    // Deposit Hop1: anyEvmChain -> cchain
    describe('Deposit Hop1 using stargate', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;[ alice, bob ] = signers.map((s) => s.address)
            await utils.forkNetwork('mainnet', ethForkBlock) // Fork Mainnet
            await utils.impersonateAccount(UsdcWhaleMainnet)
            usdcWhaleMainnet = await ethers.provider.getSigner(UsdcWhaleMainnet)
            ;([stargateRouter, stargateBridge, stargateUSDCPool, usdcMainnetInstnace] = await Promise.all([
                ethers.getContractAt('IStargateRouter', MainnetStargateRouter),
                ethers.getContractAt('IStarGateBridge', ETHStargateBridge),
                ethers.getContractAt('IStarGatePool', MainnetStargateUSDCPool),
                ethers.getContractAt('IERC20', UsdcMainnet),
            ]))

            adapterParams = ethers.utils.solidityPack(
                ['uint16', 'uint'],
                [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
            )
        })

        after(async function() {
            await network.provider.request({
                method: "hardhat_reset",
                params: [],
            });
        })

        it('deposit using stargate for hop1', async () => {
            const depositAmount = _1e6.mul(2000) // 2000 usdc
            let [ sgPayload,, ] = buildDepositPayload(
                bob, 0, depositAmount, 0 /** toGas */, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            )

            let l0Fee = await stargateRouter.quoteLayerZeroFee(
                lzChainIdForCchain,
                1, // function type: see Bridge.sol for all types
                ethers.utils.solidityPack(['address'], [ bob ]), // destination of tokens, random address for this test
                sgPayload,
                { dstGasForCall: 0, dstNativeAmount: 0, dstNativeAddr: '0x', }
            )

            const usdcBalBefore = await usdcMainnetInstnace.balanceOf(usdcWhaleMainnet._address)

            await usdcMainnetInstnace.connect(usdcWhaleMainnet).approve(stargateRouter.address, depositAmount)
            await expect(stargateRouter.connect(usdcWhaleMainnet).swap(
                lzChainIdForCchain,
                srcPoolIdForUSDCMainnet,
                1, // destPoolIdForUSDCAvax
                usdcWhaleMainnet._address,
                depositAmount,
                0,
                { dstGasForCall: 0, dstNativeAmount: 0, dstNativeAddr: '0x' },
                ethers.utils.solidityPack(['address'], [ bob ]),
                sgPayload,
                { value: l0Fee[0] }
            ))
            .to.emit(stargateUSDCPool, 'Swap')
            .to.emit(stargateUSDCPool, 'SendCredits')
            .to.emit(stargateBridge, 'SendMsg')

            const usdcBalAfter = await usdcMainnetInstnace.balanceOf(usdcWhaleMainnet._address)
            expect(depositAmount).to.eq(usdcBalBefore.sub(usdcBalAfter))
        })
    })

    // Deposit Hop2: stargate -> cchain -> hubbleNet
    describe('Deposit Hop2 using stargate and layerZero', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;([, alice ] = signers.map((s) => s.address))
            await utils.forkCChain(avaxForkBlock) // Fork Avalanche
            bob = emptyAddressCchain;
            // deploy protocol contracts
            ;({ marginAccountHelper, proxyAdmin } = await utils.setupContracts({ mockOrderBook: false, testClearingHouse: false }))
            // deploy bridge contracts
            contracts = await setupAvaxContracts(proxyAdmin.address, marginAccountHelper.address)
            ;({ usdcAvaxInstance, hgtRemote, hgt, avaxPriceFeed, lzEndpointMockRemote, usdcPriceFeed } = contracts)

            // fund hgt with 1m gas token
            hgtBalance = ethers.utils.hexStripZeros(_1e18.mul(_1e6))
            await utils.setBalance(hgt.address, hgtBalance)
            hgtBalance = BigNumber.from(hgtBalance) // converted to BigNumber

            // fund hgtRemote with 100 avax to pay for gas
            hgtRemoteBalance = ethers.utils.hexStripZeros(_1e18.mul(100))
            await utils.setBalance(hgtRemote.address, hgtRemoteBalance)
            hgtRemoteBalance = BigNumber.from(hgtRemoteBalance) // converted to BigNumber

            depositAmount = _1e6.mul(1000) // 1000 usdc
            // simulate funds received from stargate to hgtRemote
            usdcWhale = await ethers.provider.getSigner(USDCRichAddressAvax)
            await utils.impersonateAccount(USDCRichAddressAvax)
            await usdcAvaxInstance.connect(usdcWhale).transfer( hgtRemote.address, depositAmount)
            // whitelist signer[0] as relayer
            await hgtRemote.setWhitelistRelayer(signers[0].address, true)
            aliceInitialBalance = await ethers.provider.getBalance(alice)

            adapterParams = ethers.utils.solidityPack(
                ['uint16', 'uint'],
                [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
                // @todo need to find optimal gasAmount
            )
        })

        after(async function() {
            await network.provider.request({
                method: "hardhat_reset",
                params: [],
            });
        })

        it('alice deposits margin and gas token to bob\'s account using sg', async () => {
            toGas = depositAmount.div(2)

            let [ sgPayload, lzPayload ] = buildDepositPayload(
                bob, 0, depositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            )

            const nativeFee = await lzEndpointMockRemote.estimateFees(hubbleChainId, hgtRemote.address, lzPayload, false, adapterParams)

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

            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1, // nonce
                    usdcAvaxInstance.address,
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'StargateDepositProcessed').withArgs(lzChainIdForEthMainnet, 1 /** nonce */, 0 /** tokenIdx */, depositAmount, sgPayload)
            .to.emit(hgtRemote, 'SendToChain').withArgs(hubbleChainId, 1, lzPayload)
            .to.emit(hgt, 'ReceiveFromChain').withArgs(cchainId, bob, 0, actualDepositAmount, metadata, 1)

            // hubbleNet assertions
            // margin and gas token should be deposited to bob's account
            expect(await marginAccount.margin(0, bob)).to.eq(actualDepositAmount.sub(toGas))
            expect(await ethers.provider.getBalance(bob)).to.eq(toGas.mul(_1e12))
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            // no change in alice's balance
            expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
            expect(await ethers.provider.getBalance(alice)).to.eq(aliceInitialBalance)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            // hgt assertions
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(_1e12))
            // hgtRemote assertions
            expect(await ethers.provider.getBalance(hgtRemote.address)).to.eq(hgtRemoteBalance.sub(nativeFee[0]))
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount)
            expect(await hgtRemote.feeCollected(0)).to.eq(l0Fee)
        })

        it('deposit hop2 fails because of lz tx fail', async function () {
            await usdcAvaxInstance.connect(usdcWhale).transfer(hgtRemote.address, depositAmount)
            ;([ sgPayload, lzPayload, metadata ] = buildDepositPayload(
                bob, 0, depositAmount, 0, false, ZERO_ADDRESS, adapterParams
            ))
            // set hgtRemote gas balance very low to simulate lz tx fail
            await utils.setBalance(hgtRemote.address, ethers.utils.hexStripZeros(_1e6))
            failedMsgPayload = ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [ usdcAvaxInstance.address, depositAmount, sgPayload ])

            const reason = '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002c48475452656d6f74653a20496e73756666696369656e74206e617469766520746f6b656e2062616c616e63650000000000000000000000000000000000000000' // HGTRemote: Insufficient native token balance, low level data returned by catch
            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    2,
                    usdcAvaxInstance.address,
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, ETHStargateBridge, 2 /** nonce */, failedMsgPayload, reason)

            const storedPayloadHash = await hgtRemote.failedMessages(lzChainIdForEthMainnet, ETHStargateBridge, 2)
            expect(storedPayloadHash).to.eq(ethers.utils.keccak256(failedMsgPayload))
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.mul(2))
            // no change on hgt side
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(_1e12))
        })

        it('retry failed deposit', async function () {
            // increase hgtRemote balance
            await utils.setBalance(hgtRemote.address, ethers.utils.hexStripZeros(_1e18.mul(100)))

            const nativeFee = await lzEndpointMockRemote.estimateFees(hubbleChainId, hgtRemote.address, lzPayload, false, adapterParams)

            // get avax and usdc price
            let latestAnswer = await avaxPriceFeed.latestRoundData()
            const avaxPrice = latestAnswer[1].div(100)
            latestAnswer = await usdcPriceFeed.latestRoundData()
            const usdcPrice = latestAnswer[1].div(100)
            const l0Fee = nativeFee[0].mul(avaxPrice).div(usdcPrice).div(_1e12)
            actualDepositAmount = depositAmount.sub(l0Fee)

            ;([, lzPayload, metadata] = buildDepositPayload(
                bob, 0, actualDepositAmount, 0, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            ))

            await expect(
                hgtRemote.retryDeposit(lzChainIdForEthMainnet, ETHStargateBridge, 2, failedMsgPayload + '00')
            ).to.be.revertedWith('HGTRemote: invalid payload')

            await expect(
                hgtRemote.retryDeposit(lzChainIdForEthMainnet, ETHStargateBridge, 2, failedMsgPayload)
            )
            .to.emit(hgtRemote, 'StargateDepositProcessed').withArgs(lzChainIdForEthMainnet, 2 /** nonce */, 0 /** tokenIdx */, depositAmount, sgPayload)
            .to.emit(hgtRemote, 'SendToChain').withArgs(hubbleChainId, 2, lzPayload)
            .to.emit(hgt, 'ReceiveFromChain').withArgs(cchainId, bob, 0, actualDepositAmount, metadata, 2)

            const storedPayloadHash = await hgtRemote.failedMessages(lzChainIdForEthMainnet, ETHStargateBridge, 1)
            expect(storedPayloadHash).to.eq(ethers.utils.hexZeroPad("0x", 32))

            expect(await marginAccount.margin(0, bob)).to.eq(actualDepositAmount.mul(2).sub(toGas))
            expect(await ethers.provider.getBalance(bob)).to.eq(toGas.mul(_1e12))
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(2).mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(2).mul(_1e12))
        })

        it('deposit hop2 fails due to higher l0 fee than deposited amount', async function () {
            smallAmount = _1e6.div(100)
            await usdcAvaxInstance.connect(usdcWhale).transfer( hgtRemote.address, smallAmount)
            let [ sgPayload, ] = buildDepositPayload(
                bob, 0, smallAmount, 0, false, ZERO_ADDRESS, adapterParams
            )
            failedMsgPayload = ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [ usdcAvaxInstance.address, smallAmount, sgPayload ])

            const reason = '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001f48475452656d6f74653a20416d6f756e74206c657373207468616e2066656500' // 'HGTRemote: Amount less than fee', low level data returned by catch
            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    3, // nonce
                    usdcAvaxInstance.address,
                    smallAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, ETHStargateBridge, 3 /** nonce */, failedMsgPayload, reason)

            const storedPayloadHash = await hgtRemote.failedMessages(lzChainIdForEthMainnet, ETHStargateBridge, 3)
            expect(storedPayloadHash).to.eq(ethers.utils.keccak256(failedMsgPayload))
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.mul(2).add(smallAmount))
            // no change on hgt side
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(2).mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(2).mul(_1e12))
        })


        it('Rescue funds', async function () {
            bob = ethers.provider.getSigner(bob)
            await utils.impersonateAccount(bob._address)
            // retry deposit fails again
            await expect(
                hgtRemote.retryDeposit(lzChainIdForEthMainnet, ETHStargateBridge, 3, failedMsgPayload)
            ).to.be.revertedWith('HGTRemote: Amount less than fee')

            // revert if no funds to rescue
            await expect(
                hgtRemote.connect(bob).rescueDepositFunds(lzChainIdForEthMainnet, ETHStargateBridge, 2 /** wrong nonce */, failedMsgPayload)
            ).to.be.revertedWith('HGTRemote: no stored message')

            // revert if not called by receiver
            await expect(
                hgtRemote.rescueDepositFunds(lzChainIdForEthMainnet, ETHStargateBridge, 3, failedMsgPayload)
            ).to.be.revertedWith('HGTRemote: sender must be receiver')

            // rescue funds
            await hgtRemote.connect(bob).rescueDepositFunds(lzChainIdForEthMainnet, ETHStargateBridge, 3, failedMsgPayload)

            const storedPayloadHash = await hgtRemote.failedMessages(lzChainIdForEthMainnet, ETHStargateBridge, 3)
            expect(storedPayloadHash).to.eq(ethers.utils.hexZeroPad("0x", 32))

            expect(await usdcAvaxInstance.balanceOf(bob._address)).to.eq(smallAmount)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.mul(2))
        })

        it('setWhitelistRelayer', async () => {
            await expect(hgtRemote.connect(signers[1]).setWhitelistRelayer(alice, true)).to.be.revertedWith('ONLY_GOVERNANCE')
            await hgtRemote.setWhitelistRelayer(alice, true)
            let isWhiteList = await hgtRemote.whitelistedRelayer(alice)
            expect(isWhiteList).to.eq(true)
            await hgtRemote.setWhitelistRelayer(alice, false)
            isWhiteList = await hgtRemote.whitelistedRelayer(alice)
            expect(isWhiteList).to.eq(false)
        })

        it('setStargateConfig', async () => {
            const testStargateAddress = lzEndpointMockRemote.address
            await expect(hgtRemote.connect(signers[1]).setStargateConfig(testStargateAddress)).to.be.revertedWith('ONLY_GOVERNANCE')
            await hgtRemote.setStargateConfig(testStargateAddress)
            const stargateAddress = await hgtRemote.stargateRouter()
            expect(stargateAddress).to.eq(testStargateAddress)
        })

        it('depositByStargate revert because of onlyMyself', async () => {
            await expect(hgtRemote.processSgReceive(
                lzChainIdForEthMainnet,
                1,
                usdcAvaxInstance.address,
                depositAmount,
                sgPayload
            )).to.be.revertedWith('Only myself')
        })

        it('sgReceive revert because of wrong token address', async () => {
            failedMsgPayload = ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [ UsdcMainnet, depositAmount, sgPayload ])
            const reason = '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001948475452656d6f74653a20746f6b656e206d69736d6174636800000000000000' // HGTRemote: token mismatch, low level data returned by catch
            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1,
                    UsdcMainnet, /** Invalid usdc token(rightTokenAddress: usdcAvax) */
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, ETHStargateBridge, 1 /** nonce */, failedMsgPayload, reason)
        })

        it('generic errors are also caught in sgReceive', async () => {
            await hgtRemote.setLZClient(ZERO_ADDRESS)
            failedMsgPayload = ethers.utils.defaultAbiCoder.encode(['address', 'uint256', 'bytes'], [ usdcAvaxInstance.address, depositAmount, sgPayload ])
            const reason = '0x'
            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1,
                    usdcAvaxInstance.address,
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, ETHStargateBridge, 1 /** nonce */, failedMsgPayload, reason)
            expect(await hgtRemote.failedMessages(lzChainIdForEthMainnet, ETHStargateBridge, 1)).to.eq(ethers.utils.keccak256(failedMsgPayload))
        })
    })
})
