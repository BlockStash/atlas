// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAtlasPriceEngine {
    function getStockPriceUSD(bytes32 stockId)
        external
        view
        returns (uint256 price, uint256 updatedAt, uint256 validUntil);
    function getStockPriceUSDT(bytes32 stockId) external view returns (uint256);
}
