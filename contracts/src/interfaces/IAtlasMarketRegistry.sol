// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAtlasMarketRegistry {
    struct Stock {
        bytes32 stockId;
        address token;
        string ticker;
        string companyName;
        bytes2 country;
        bytes32 region;
        string exchange;
        bytes3 nativeCurrency;
        bytes32 priceFeedId;
        bool active;
    }
    function getStock(bytes32 stockId) external view returns (Stock memory);
    function isMarketOpen(bytes32 region) external view returns (bool);
    function stockCount() external view returns (uint256);
    function stockIdAt(uint256 index) external view returns (bytes32);
}
