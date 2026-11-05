// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface IAtlasVault is IERC4626 {
    function uniqueDepositors() external view returns (uint256);
    function cumulativeDeposits(address user) external view returns (uint256);
}
