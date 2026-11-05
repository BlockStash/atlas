// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAtlasTradingEngine {
    function buy(bytes32 stockId, uint256 quantity, uint256 maxShares, uint256 deadline) external returns (uint256);
    function sell(bytes32 stockId, uint256 quantity, uint256 minShares, uint256 deadline) external returns (uint256);
    function quoteBuy(bytes32 stockId, uint256 quantity)
        external
        view
        returns (uint256 assets, uint256 fee, uint256 shares);
    function quoteSell(bytes32 stockId, uint256 quantity)
        external
        view
        returns (uint256 assets, uint256 fee, uint256 shares);
}
