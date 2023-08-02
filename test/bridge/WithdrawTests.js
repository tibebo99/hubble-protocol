const { expect } = require('chai')
const { ethers } = require('hardhat')
const { BigNumber } = require('ethers')
const utils = require('../utils')

const lzChainIdForEthMainnet = 101
const srcPoolIdForUSDCMainnet = 1
const avaxForkBlock = 32461637
const { constants: { _1e6, _1e12, _1e18, ZERO } } = utils

const {
    setupAvaxContracts,
    buildWithdrawPayload,
    hubbleChainId,
    cchainId,
    ZERO_ADDRESS,
} = require('./bridgeUtils')

const AvaxStargateRouter = '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd'
const AvaxStargateBridge = '0x9d1B1669c73b033DFe47ae5a0164Ab96df25B944'
const AvaxStargateUSDCPool = '0x1205f31718499dBf1fCa446663B532Ef87481fe1'

const emptyAddressCchain = '0x19ae07eEc761427c8659cc5E62bd8673b39aEaf5' // 0 token balance
const USDCRichAddressAvax = '0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9'


describe('Multi-chain Withdrawals', async function () {
    describe('Withdraw Hops from hubble to avax to anyEvmChain', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;([, alice ] = signers.map((s) => s.address))
            await utils.forkCChain(avaxForkBlock) // Fork Avalanche
            bob = await ethers.provider.getSigner(emptyAddressCchain)
            // deploy protocol contracts
            ;({ marginAccountHelper, proxyAdmin } = await utils.setupContracts({ mockOrderBook: false, testClearingHouse: false }))
            // deploy bridge contracts
            contracts = await setupAvaxContracts(proxyAdmin.address, marginAccountHelper.address)
            ;({ usdcAvaxInstance, hgtRemote, hgt, lzClient, avaxPriceFeed, lzEndpointMockRemote, lzEndpointMockBase, usdcPriceFeed } = contracts)

            ;([stargateRouter, stargateBridge, stargateUSDCPool ] = await Promise.all([
                ethers.getContractAt('IStargateRouter', AvaxStargateRouter),
                ethers.getContractAt('IStarGateBridge', AvaxStargateBridge),
                ethers.getContractAt('IStarGatePool', AvaxStargateUSDCPool),
            ]))

            // fund hgt with 1m gas token
            hgtBalance = ethers.utils.hexStripZeros(_1e18.mul(_1e6))
            await utils.setBalance(hgt.address, hgtBalance)
            hgtBalance = BigNumber.from(hgtBalance) // converted to BigNumber

            // fund hgtRemote with 100 avax to pay for gas
            hgtRemoteBalance = ethers.utils.hexStripZeros(_1e18.mul(100))
            await utils.setBalance(hgtRemote.address, hgtRemoteBalance)
            hgtRemoteBalance = BigNumber.from(hgtRemoteBalance) // converted to BigNumber

            // deposit funds to bob's gas wallet
            depositAmount = _1e6.mul(1000) // 1000 usdc
            usdcWhale = await ethers.provider.getSigner(USDCRichAddressAvax)
            await utils.impersonateAccount(usdcWhale._address)
            await usdcAvaxInstance.connect(usdcWhale).approve(hgtRemote.address, depositAmount)

            const depositVars = {
                to: bob._address,
                tokenIdx: 0,
                amount: depositAmount,
                toGas: depositAmount, // deposit all as gas token
                isInsuranceFund: false,
                refundAddress: usdcWhale._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams: '0x'
            }
            const l0Fee = await hgtRemote.estimateSendFee(depositVars)
            await hgtRemote.connect(usdcWhale).deposit(depositVars, { value: l0Fee[0] })
            await utils.stopImpersonateAccount(usdcWhale._address)
            expect(await ethers.provider.getBalance(bob._address)).to.eq(depositAmount.mul(_1e12))
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

        // withdraw hubbleNet -> cchain -> stargate
        it('Withdraw using l0 and stargate', async () => {
            // bob withdraws funds
            let withdrawAmount = depositAmount.mul(_1e12) // scale to 18 decimals
            const withdrawVars = {
                dstChainId: cchainId,
                secondHopChainId: lzChainIdForEthMainnet,
                dstPoolId: srcPoolIdForUSDCMainnet,
                to: alice,
                tokenIdx: 0,
                amount: withdrawAmount,
                amountMin: withdrawAmount.mul(99).div(100).div(_1e12), // 1% slippage
                refundAddress: bob._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams
            }

            await utils.impersonateAccount(bob._address)
            await expect(hgt.connect(bob).withdraw(withdrawVars, { value: 0 })
                ).to.be.revertedWith('HGT: Insufficient native token transferred')

            withdrawAmount = await ethers.provider.getBalance(bob._address) // withdraw all
            withdrawAmount = withdrawAmount.sub(_1e18.div(4)) // reserve $0.25 to pay for gas
            const l0Fee = await hgt.estimateSendFee(withdrawVars)
            // calculate stargate fee in USDC
            const nativeFee = await stargateRouter.quoteLayerZeroFee(
                lzChainIdForEthMainnet,
                1, // function type: see Bridge.sol for all types
                ethers.utils.solidityPack(['address'], [alice]),
                '0x',
                { dstGasForCall: 0, dstNativeAmount: 0, dstNativeAddr: '0x' }
            )
            // get avax and usdc price
            let latestAnswer = await avaxPriceFeed.latestRoundData()
            const avaxPrice = latestAnswer[1].div(100)
            latestAnswer = await usdcPriceFeed.latestRoundData()
            const usdcPrice = latestAnswer[1].div(100)
            const stargateFee = nativeFee[0].mul(avaxPrice).div(usdcPrice).div(_1e12)

            withdrawVars.amount = withdrawAmount.sub(l0Fee[0])
            withdrawVars.amountMin = withdrawVars.amount.mul(99).div(100).div(_1e12) // 1% slippage
            // subtract stargate fee from minimum final amount
            withdrawVars.amountMin = withdrawVars.amountMin.sub(stargateFee)

            await expect(
                hgt.connect(bob).withdraw(withdrawVars, { value: withdrawAmount })
            )
                .to.emit(hgt, 'SendToChain').withArgs(cchainId, bob._address, alice, 0, withdrawVars.amount.div(_1e12), 1)
                .to.emit(hgtRemote, 'ReceiveFromHubbleNet').withArgs(hubbleChainId, alice, withdrawVars.amount.div(_1e12), 1)
                .to.emit(stargateBridge, 'SendMsg')
                .to.emit(stargateUSDCPool, 'Swap')
                .to.emit(stargateUSDCPool, 'SendCredits')

            // assert for hgt
            expect(await ethers.provider.getBalance(bob._address)).to.lte(_1e18.div(4)) // $0.25 left, some paid in gas
            expect(await hgt.circulatingSupply(0)).to.eq(depositAmount.mul(_1e12).sub(withdrawVars.amount))
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.add(withdrawVars.amount).sub(depositAmount.mul(_1e12)))

            // assert for hgtRemote
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.sub(withdrawVars.amount.div(_1e12)).add(stargateFee))
            expect(await hgtRemote.feeCollected(0)).to.eq(stargateFee)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO) // funds will be credited on eth mainnet via stargate
        })

        it('withdraw fail because of slippage', async () => {
            // deposit funds to bob's gas wallet
            await utils.impersonateAccount(usdcWhale._address)
            await usdcAvaxInstance.connect(usdcWhale).approve(hgtRemote.address, depositAmount)

            const depositVars = {
                to: bob._address,
                tokenIdx: 0,
                amount: depositAmount,
                toGas: depositAmount, // deposit all as gas token
                isInsuranceFund: false,
                refundAddress: usdcWhale._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams: '0x'
            }
            let l0Fee = await hgtRemote.estimateSendFee(depositVars)
            await hgtRemote.connect(usdcWhale).deposit(depositVars, { value: l0Fee[0] })
            await utils.stopImpersonateAccount(usdcWhale._address)
            hgtRemoteUSDCBalance = await usdcAvaxInstance.balanceOf(hgtRemote.address)
            hgtBalance = await ethers.provider.getBalance(hgt.address)

            // withdraw half of the funds
            withdrawAmount = depositAmount.mul(_1e12).div(2) // scale to 18 decimals
            withdrawVars = {
                dstChainId: cchainId,
                secondHopChainId: lzChainIdForEthMainnet,
                dstPoolId: srcPoolIdForUSDCMainnet,
                to: alice,
                tokenIdx: 0,
                amount: withdrawAmount,
                amountMin: withdrawAmount.div(_1e12), // 0% slippage, 0 stargate fee (will fail)
                refundAddress: bob._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams
            }

            l0Fee = await hgt.estimateSendFee(withdrawVars)
            let tx = await hgt.connect(bob).withdraw(withdrawVars, { value: withdrawAmount.add(l0Fee[0]) })

            withdrawVars.amount = withdrawAmount.div(_1e12)
            lzPayload = buildWithdrawPayload(withdrawVars)
            srcAddress = ethers.utils.solidityPack(['address', 'address'], [hgt.address, lzClient.address])
            const reason = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001b53746172676174653a20736c69707061676520746f6f20686967680000000000" // Stargate: slippage too high. Converted to hex byes with some extra data and padding (returned by excessivelySafeCall lib)

            await expect(tx).to.emit(hgt, 'SendToChain').withArgs(cchainId, bob._address, alice, 0, withdrawAmount.div(_1e12), 2)
            .to.emit(lzClient, 'MessageFailed').withArgs(hubbleChainId, srcAddress, 2, lzPayload, reason)

            const storedPayloadHash = await lzClient.failedMessages(hubbleChainId, srcAddress, 2)
            expect(storedPayloadHash).to.eq(ethers.utils.keccak256(lzPayload))
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(hgtRemoteUSDCBalance) // no change
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.add(withdrawAmount))
        })

        it('rescue funds from failed withdraw', async () => {
            // retry message fails
            await expect(lzClient.retryMessage(hubbleChainId, srcAddress, 2, lzPayload)
            ).to.be.revertedWith('Stargate: slippage too high')

            // reverts if sender is not receiver
            await expect(hgtRemote.rescueWithdrawFunds(hubbleChainId, srcAddress, 2, lzPayload)
            ).to.be.revertedWith('HGTRemote: sender must be receiver')

            alice = signers[1]
            // reverts if no funds to rescue
            await expect(hgtRemote.connect(alice).rescueWithdrawFunds(hubbleChainId, srcAddress, 3, lzPayload)
            ).to.be.revertedWith('LZClient: no stored message')

            // revert if wrong payload
            await expect(hgtRemote.connect(alice).rescueWithdrawFunds(hubbleChainId, srcAddress, 2, lzPayload + '00')
            ).to.be.revertedWith('LZClient: invalid payload')

            // rescue funds
            await hgtRemote.connect(alice).rescueWithdrawFunds(hubbleChainId, srcAddress, 2, lzPayload)
            expect(await usdcAvaxInstance.balanceOf(alice.address)).to.eq(withdrawVars.amount)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(hgtRemoteUSDCBalance.sub(withdrawVars.amount))
        })
    })
})
