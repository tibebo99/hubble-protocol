const utils = require('./utils')
const { BigNumber } = require('ethers')
const { expect } = require('chai')

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
} = utils

describe('IOC Order Book', function () {
    before(async function () {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
        ;({ iocOrderBook, usdc, oracle, weth, marginAccount, clearingHouse, juror, lastTimestamp } = await setupContracts({ iocOrderBook: true, mockOrderBook: false, testClearingHouse: false }))

        await addMargin(alice, _1e6.mul(4000))
    })

    it('place an ioc order', async function() {
        shortOrder = {
            orderType: 1,
            expireAt: lastTimestamp + 5, // Math.floor(Date.now()/1000) + 5,
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        orderHash = await iocOrderBook.getOrderHash(shortOrder)
        const tx = await iocOrderBook.connect(alice).placeOrders([shortOrder])
        const _timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        await expect(tx).to.emit(iocOrderBook, "OrderPlaced").withArgs(
            shortOrder.trader,
            orderHash,
            Object.values(shortOrder),
            _timestamp
        )

        // await expect(iocOrderBook.connect(alice).placeOrders([shortOrder])).to.revertedWith('already exists')
        orderStatus = await iocOrderBook.orderStatus(orderHash)
        expect(orderStatus.blockPlaced).to.eq(tx.blockNumber)
        expect(orderStatus.filledAmount).to.eq(0)
        expect(orderStatus.status).to.eq(1) // placed
    })

    it('slots are as expected', async function() {
        // orderInfo
        const ORDER_INFO_SLOT = 53
        let baseOrderInfoSlot = ethers.utils.keccak256(ethers.utils.solidityPack(['bytes32', 'uint256'], [orderHash, ORDER_INFO_SLOT]))
        let storage = await ethers.provider.getStorageAt(
            iocOrderBook.address,
            BigNumber.from(baseOrderInfoSlot)
        )
        expect(BigNumber.from(storage)).to.eq(orderStatus.blockPlaced)
        storage = await ethers.provider.getStorageAt(
            iocOrderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(1)
        )
        expect(0).to.eq(BigNumber.from(storage).fromTwos(256)) // filled amount
        storage = await ethers.provider.getStorageAt(
            iocOrderBook.address,
            BigNumber.from(baseOrderInfoSlot).add(2)
        )
        expect(BigNumber.from(storage)).to.eq(1) // Placed

        // expiration cap
        const EXPIRATION_CAP_SLOT = 54
        storage = await ethers.provider.getStorageAt(
            iocOrderBook.address,
            BigNumber.from(ethers.utils.solidityPack(['uint256'], [EXPIRATION_CAP_SLOT]))
        )
        expect(BigNumber.from(storage)).to.eq(20)
    })
})
