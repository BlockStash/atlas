// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "equality");
    }

    function ok(bool b) internal pure {
        require(b, "assertion");
    }

    function bound(uint256 x, uint256 a, uint256 b) internal pure returns (uint256) {
        return a + x % (b - a + 1);
    }
}
