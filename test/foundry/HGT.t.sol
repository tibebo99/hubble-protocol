// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";
import "@layerzerolabs/solidity-examples/contracts/util/BytesLib.sol";
import { IHGTRemote, IHGT } from "../../contracts/layer0/L0Interfaces.sol";

contract HGTTests is Utils {
    using BytesLib for bytes;
    // inital gas token supply to be minted for hgt contract
    uint public totalSupply = 1e6 ether;
    bytes public adapterParams = abi.encodePacked(uint16(1), uint256(5e5));

    event SendToChain(uint16 indexed _dstChainId, uint256 indexed _nonce, bytes _lzPayload);
    event SendToChain(uint16 indexed _dstChainId, address indexed _from, address indexed _toAddress, uint _tokenIdx,  uint _amount, uint256 _nonce);
    event ReceiveFromChain(uint16 indexed _srcChainId, address indexed _to, uint _tokenIdx, uint _amount, bytes _metadata, uint256 _nonce);
    event ReceiveFromHubbleNet(uint16 indexed _dstChainId, address indexed _to, uint _amount, bool _lzSendSuccess, uint256 _nonce);

    function setUp() public {
        setupContracts();

        // internal bookkeeping for endpoints (not part of a real deploy, just for this test)
        lzEndpointBase.setDestLzEndpoint(address(lzClient), address(lzEndpointOther));
        lzEndpointOther.setDestLzEndpoint(address(hgt), address(lzEndpointBase));

        //------  setTrustedRemote(s) -------------------------------------------------------
        // for each HGT, setTrustedRemote to allow it to receive from the remote HGT contract.
        // Note: This is sometimes referred to as the "wire-up" process.
        vm.startPrank(governance);
        hgt.setTrustedRemote(otherChainId, abi.encodePacked(address(lzClient), address(hgt)));
        lzClient.setTrustedRemote(baseChainId, abi.encodePacked(address(hgt), address(lzClient)));
        vm.stopPrank();

        // fund HGT with gas token
        vm.deal(address(hgt), totalSupply);
        assertEq(address(hgt).balance, totalSupply);
    }

    function testDepositToMargin(uint amount, uint toGas) public {
        // uint amount = 100e6;
        vm.assume(amount >= 1e6 && amount <= totalSupply / 1e12 && amount >= toGas);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(hgt.circulatingSupply(0), 0);

        // deposit - alice deposits gas token to bob's account on hubbleNet
        usdc.mint(alice, amount);

        IHGTRemote.DepositVars memory sendVars = IHGTRemote.DepositVars({
            to: bob,
            tokenIdx: 0,
            amount: amount,
            toGas: toGas,
            isInsuranceFund: false,
            refundAddress: payable(alice),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });

        (uint nativeFee, ) = hgtRemote.estimateSendFee(sendVars);
        vm.deal(alice, nativeFee);

        vm.startPrank(alice);
        usdc.approve(address(hgtRemote), amount);

        (bytes memory lzPayload, bytes memory metadata) = buildLzPayload(sendVars);
        vm.expectEmit(true, true, false, true, address(hgt));
        emit ReceiveFromChain(otherChainId, sendVars.to, sendVars.tokenIdx, sendVars.amount, metadata, 1 /* nonce */);
        vm.expectEmit(true, true, false, true, address(hgtRemote));
        emit SendToChain(baseChainId, 1 /* nonce */, lzPayload);

        hgtRemote.deposit{value: nativeFee}(sendVars);
        vm.stopPrank();

        assertEq(alice.balance, 0);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), amount);

        assertEq(marginAccount.margin(0, bob), int(amount - toGas));
        assertEq(insuranceFund.balanceOf(bob), 0);
        assertEq(bob.balance, toGas * 1e12);
        // scale amount to 18 decimals
        amount *= 1e12;
        assertEq(hgt.circulatingSupply(0), amount);
    }

    function testDepositToIF(uint amount, uint toGas) public {
        // uint amount = 100e6;
        vm.assume(amount >= 1e6 && amount <= totalSupply / 1e12 && amount >= toGas);
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(hgt.circulatingSupply(0), 0);

        // deposit - alice deposits gas token to bob's account on hubbleNet
        usdc.mint(alice, amount);

        IHGTRemote.DepositVars memory sendVars = IHGTRemote.DepositVars({
            to: bob,
            tokenIdx: 0,
            amount: amount,
            toGas: toGas,
            isInsuranceFund: true,
            refundAddress: payable(alice),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });

        (uint nativeFee, ) = hgtRemote.estimateSendFee(sendVars);
        vm.deal(alice, nativeFee);

        vm.startPrank(alice);
        usdc.approve(address(hgtRemote), amount);

        (bytes memory lzPayload, bytes memory metadata) = buildLzPayload(sendVars);
        vm.expectEmit(true, true, false, true, address(hgt));
        emit ReceiveFromChain(otherChainId, sendVars.to, sendVars.tokenIdx, sendVars.amount, metadata, 1 /* nonce */);
        vm.expectEmit(true, true, false, true, address(hgtRemote));
        emit SendToChain(baseChainId, 1 /* nonce */, lzPayload);

        hgtRemote.deposit{value: nativeFee}(sendVars);
        vm.stopPrank();

        assertEq(alice.balance, 0);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), amount);

        assertEq(marginAccount.margin(0, bob), 0);
        assertEq(insuranceFund.balanceOf(bob), amount - toGas);
        assertEq(bob.balance, toGas * 1e12);
        // scale amount to 18 decimals
        amount *= 1e12;
        assertEq(hgt.circulatingSupply(0), amount);
    }

    function testCannotDeposit() public {
        // cannot deposit 0 amount
        IHGTRemote.DepositVars memory sendVars = IHGTRemote.DepositVars({
            to: bob,
            tokenIdx: 0,
            amount: 0,
            toGas: 0,
            isInsuranceFund: false,
            refundAddress: payable(alice),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });

        vm.startPrank(alice);
        vm.expectRevert("HGTRemote: Insufficient amount");
        hgtRemote.deposit(sendVars);
        vm.stopPrank();
        // cannot deposit if send fee is low
        sendVars.amount += 1e6;
        usdc.mint(alice, sendVars.amount);
        (uint nativeFee, ) = hgtRemote.estimateSendFee(sendVars);
        vm.deal(alice, nativeFee);

        vm.startPrank(alice);
        usdc.approve(address(hgtRemote), sendVars.amount);
        vm.expectRevert("LayerZeroMock: not enough native for fees");
        hgtRemote.deposit{value: nativeFee - 1}(sendVars);

        // cannot deposit if invalid tokenIdx
        sendVars.tokenIdx = 1;
        vm.expectRevert("HGTRemote: Invalid token index");
        hgtRemote.deposit{value: nativeFee}(sendVars);
        sendVars.tokenIdx = 0;

        // cannot deposit if toGas > amount
        sendVars.toGas = sendVars.amount + 1;
        vm.expectRevert("HGTRemote: deposit < airdrop");
        hgtRemote.deposit{value: nativeFee}(sendVars);
        sendVars.toGas = 0;

        // successful deposit
        hgtRemote.deposit{value: nativeFee}(sendVars);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), sendVars.amount);
        sendVars.amount *= 1e12;
        assertEq(hgt.circulatingSupply(0), sendVars.amount);
    }

    function testWithdraw(uint amount) public {
        // uint amount = 1e6;
        vm.assume(amount >= 1e5 && amount <= totalSupply / 1e12);

        // deposit - alice deposits gas token to bob's account on hubbleNet
        uint initialDepositUsdc;
        (amount, initialDepositUsdc) = _deposit(alice, bob, amount, amount);

        // withdraw
        vm.startPrank(bob);
        // bob withdraws remaining to their account on C-chain
        amount = amount - (amount / 3);
        IHGT.WithdrawVars memory sendVars = IHGT.WithdrawVars({
            dstChainId: otherChainId,
            secondHopChainId: 0,
            dstPoolId: 0,
            to: bob,
            tokenIdx: 0,
            amount: amount,
            amountMin: amount,
            refundAddress: payable(bob),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });
        (uint nativeFee, ) = hgt.estimateSendFee(sendVars);
        vm.deal(bob, amount + nativeFee);

        uint256 beforeSupply = hgt.circulatingSupply(0);

        hgt.withdraw{value: amount + nativeFee}(sendVars);
        vm.stopPrank();

        // assertions
        assertEq(alice.balance, 0);
        assertEq(bob.balance, 0);
        assertEq(usdc.balanceOf(alice), 0);
        uint bobUsdcBalance = amount / 1e12;
        assertEq(usdc.balanceOf(bob), bobUsdcBalance);
        assertEq(usdc.balanceOf(address(hgtRemote)), initialDepositUsdc - bobUsdcBalance);
        assertEq(hgt.circulatingSupply(0), beforeSupply-amount);
    }

    function testCannotWithdraw() public {
        uint amount = 100 * 1e6;
        _deposit(alice, alice, amount, amount);

        // cannot withdraw if msg.value < amount
        vm.startPrank(alice);
        vm.deal(alice, 50 ether);
        IHGT.WithdrawVars memory sendVars = IHGT.WithdrawVars({
            dstChainId: otherChainId,
            secondHopChainId: 0,
            dstPoolId: 0,
            to: bob,
            tokenIdx: 0,
            amount: 50 ether,
            amountMin: 50 ether,
            refundAddress: payable(alice),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });
        (uint nativeFee, ) = hgt.estimateSendFee(sendVars);

        vm.expectRevert("HGT: Insufficient native token transferred");
        hgt.withdraw{value: sendVars.amount - 1}(sendVars);

        // cannot withdraw if withdraw amount is 0
        sendVars.amount = 0;
        vm.expectRevert("HGT: Insufficient amount or invalid user");
        hgt.withdraw{value: nativeFee }(sendVars);

        // cannot withdraw if invalid tokenIdx
        sendVars.tokenIdx = 1;
        vm.expectRevert(); // index out of bounds
        hgt.withdraw{value: nativeFee}(sendVars);
        sendVars.tokenIdx = 0;

        // successful withdraw
        sendVars.amount = 50 ether;
        vm.deal(alice, sendVars.amount + nativeFee);
        hgt.withdraw{value: sendVars.amount + nativeFee}(sendVars);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(hgtRemote)), amount - sendVars.amount / 1e12);
        assertEq(usdc.balanceOf(bob), sendVars.amount / 1e12);
    }

    function _deposit(address from, address to, uint amount, uint toGas) internal returns (uint, uint) {
        usdc.mint(from, amount);
        IHGTRemote.DepositVars memory sendVars = IHGTRemote.DepositVars({
            to: to,
            tokenIdx: 0,
            amount: amount,
            toGas: toGas,
            isInsuranceFund: false,
            refundAddress: payable(from),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });
        (uint nativeFee, ) = hgtRemote.estimateSendFee(sendVars);
        vm.deal(from, nativeFee);

        uint initialDepositUsdc = amount;
        vm.startPrank(from);
        usdc.approve(address(hgtRemote), amount);
        hgtRemote.deposit{value: nativeFee}(sendVars);
        vm.stopPrank();

        amount *= 1e12;
        assertEq(usdc.balanceOf(from), 0);
        assertEq(to.balance, toGas * 1e12);
        assertEq(hgt.circulatingSupply(0), amount);
        return (amount, initialDepositUsdc);
    }

    function buildLzPayload(IHGTRemote.DepositVars memory vars) internal pure returns (bytes memory lzPayload, bytes memory metadata) {
        metadata = abi.encode(vars.toGas, vars.isInsuranceFund);
        lzPayload = abi.encode(1 /* PT_SEND */, vars.to, vars.tokenIdx, vars.amount, metadata);
    }
}
