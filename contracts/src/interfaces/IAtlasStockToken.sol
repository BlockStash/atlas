// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAtlasStockToken is IERC20 {
    function stockId() external view returns (bytes32);
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}
