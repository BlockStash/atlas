// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IAtlasMarketRegistry} from "./interfaces/IAtlasMarketRegistry.sol";
import {IAtlasStockToken} from "./interfaces/IAtlasStockToken.sol";

contract AtlasMarketRegistry is IAtlasMarketRegistry, AccessControlDefaultAdminRules {
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");

    struct Market {
        bool enabled;
        bool open;
        uint64 updatedAt;
        uint64 validUntil;
    }
    mapping(bytes32 => Stock) private stocks;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => bool) public usedTicker;
    bytes32[] private ids;
    error InvalidStock();
    error DuplicateStock();
    error UnknownStock();
    error InvalidMarket();
    event StockCreated(bytes32 indexed stockId, address indexed token, bytes32 indexed region, string ticker);
    event StockActivated(bytes32 indexed stockId, bool active);
    event StockMetadataUpdated(bytes32 indexed stockId, string companyName, string exchange, bytes32 priceFeedId);
    event MarketStatusUpdated(bytes32 indexed region, bool enabled, bool open, uint256 validUntil);
    constructor(address admin) AccessControlDefaultAdminRules(1 days, admin) {}

    function addStock(Stock calldata stock) external onlyRole(FACTORY_ROLE) {
        if (
            stock.stockId == 0 || stock.token.code.length == 0 || bytes(stock.ticker).length == 0
                || bytes(stock.ticker).length > 24 || bytes(stock.companyName).length == 0
                || bytes(stock.companyName).length > 100 || bytes(stock.exchange).length == 0
                || bytes(stock.exchange).length > 40 || stock.country == 0 || stock.priceFeedId == 0
                || !markets[stock.region].enabled || !validCurrency(stock.nativeCurrency)
                || IAtlasStockToken(stock.token).stockId() != stock.stockId
        ) revert InvalidStock();
        bytes32 tickerKey = keccak256(abi.encode(stock.region, stock.exchange, stock.ticker));
        if (stocks[stock.stockId].token != address(0) || usedTicker[tickerKey]) revert DuplicateStock();
        usedTicker[tickerKey] = true;
        stocks[stock.stockId] = stock;
        ids.push(stock.stockId);
        emit StockCreated(stock.stockId, stock.token, stock.region, stock.ticker);
    }

    function updateStock(bytes32 id, string calldata company, string calldata exchange, bytes32 feed)
        external
        onlyRole(MARKET_ADMIN_ROLE)
    {
        Stock storage stock = stocks[id];
        if (stock.token == address(0)) revert UnknownStock();
        if (
            bytes(company).length == 0 || bytes(company).length > 100 || bytes(exchange).length == 0
                || bytes(exchange).length > 40 || feed == 0
        ) revert InvalidStock();
        bytes32 key = keccak256(abi.encode(stock.region, exchange, stock.ticker));
        bytes32 previous = keccak256(abi.encode(stock.region, stock.exchange, stock.ticker));
        if (key != previous && usedTicker[key]) revert DuplicateStock();
        usedTicker[previous] = false;
        usedTicker[key] = true;
        stock.companyName = company;
        stock.exchange = exchange;
        stock.priceFeedId = feed;
        emit StockMetadataUpdated(id, company, exchange, feed);
    }

    function setStockActive(bytes32 id, bool active) external onlyRole(MARKET_ADMIN_ROLE) {
        if (stocks[id].token == address(0)) revert UnknownStock();
        stocks[id].active = active;
        emit StockActivated(id, active);
    }

    function setMarket(bytes32 region, bool enabled, bool open, uint64 validUntil)
        external
        onlyRole(MARKET_ADMIN_ROLE)
    {
        if (region == 0 || validUntil < block.timestamp || validUntil > block.timestamp + 1 days) revert InvalidMarket();
        markets[region] = Market(enabled, open, uint64(block.timestamp), validUntil);
        emit MarketStatusUpdated(region, enabled, open, validUntil);
    }

    function isMarketOpen(bytes32 region) external view returns (bool) {
        Market memory market = markets[region];
        return market.enabled && market.open && block.timestamp <= market.validUntil;
    }

    function getStock(bytes32 id) external view returns (Stock memory) {
        if (stocks[id].token == address(0)) revert UnknownStock();
        return stocks[id];
    }

    function stockCount() external view returns (uint256) {
        return ids.length;
    }

    function stockIdAt(uint256 i) external view returns (bytes32) {
        return ids[i];
    }

    function listStockIds(uint256 offset, uint256 count) external view returns (bytes32[] memory result) {
        if (offset >= ids.length) return new bytes32[](0);
        uint256 n = count > 100 ? 100 : count;
        if (n > ids.length - offset) n = ids.length - offset;
        result = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            result[i] = ids[offset + i];
        }
    }

    function validCurrency(bytes3 currency) public pure returns (bool) {
        return currency == "INR" || currency == "USD" || currency == "GBP" || currency == "SGD" || currency == "EUR";
    }
}
