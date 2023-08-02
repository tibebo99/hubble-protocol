// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;
import "./Utils.sol";

contract VUSDWithReceiveRentrancyTest is Utils {
    event WithdrawalFailed(address indexed trader, uint amount);
    bool public failWithdraw = true;

    function setUp() public {
        setupContracts();
    }

    function testWithdrawRevertRentrancy(uint128 amount) public {
        vm.assume(amount >= 5e6);
        // mint vusd for this contract
        mintVusd(address(this), amount);
        // alice and bob also mint vusd
        mintVusd(alice, amount);
        mintVusd(bob, amount);

        // withdraw husd
        husd.withdraw(amount); // first withdraw in the array
        vm.prank(alice);
        husd.withdraw(amount);
        vm.prank(bob);
        husd.withdraw(amount);

        assertEq(husd.balanceOf(address(this)), 0);
        assertEq(husd.withdrawalQLength(), 3);
        assertEq(husd.start(), 0);

        uint scaledAmount = uint(amount) * 1e12;
        vm.expectEmit(true, false, false, true, address(husd));

        emit WithdrawalFailed(address(this), scaledAmount);
        husd.processWithdrawals();

        assertEq(husd.withdrawalQLength(), 3);
        assertEq(husd.start(), 3);
        assertEq(alice.balance, scaledAmount);
        assertEq(bob.balance, scaledAmount);
        assertEq(husd.balanceOf(address(this)), 0);
        assertEq(husd.failedWithdrawals(address(this)), scaledAmount);

        // rescue failed withdrawal
        vm.prank(bob);
        vm.expectRevert('VUSD: must have admin role');
        husd.rescueFailedWithdrawal(bob);

        vm.expectRevert('VUSD: No failed withdrawal');
        husd.rescueFailedWithdrawal(bob);

        // fail withdraw one more time
        mintVusd(address(this), amount);
        husd.withdraw(amount);
        husd.processWithdrawals();
        assertEq(husd.balanceOf(address(this)), 0);
        assertEq(husd.failedWithdrawals(address(this)), 2 * scaledAmount);

        failWithdraw = false;
        uint balanceBefore = address(this).balance;
        husd.rescueFailedWithdrawal(address(this));
        assertEq(husd.balanceOf(address(this)), 0);
        assertEq(husd.failedWithdrawals(address(this)), 0);
        assertEq(address(this).balance, balanceBefore + 2 * scaledAmount);
    }

    receive() payable external {
        if (failWithdraw) {
            husd.mintWithReserve(address(this), 1e6);
        }
    }
}
