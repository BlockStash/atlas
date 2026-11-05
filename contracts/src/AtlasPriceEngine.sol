// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAtlasMarketRegistry} from "./interfaces/IAtlasMarketRegistry.sol";
import {IAtlasPriceEngine} from "./interfaces/IAtlasPriceEngine.sol";

contract AtlasPriceEngine is IAtlasPriceEngine, AccessControlDefaultAdminRules {
    bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE");
    uint256 public constant PRICE_SCALE = 1e8;

    struct Observation {
        uint256 value;
        uint64 updatedAt;
        uint64 validUntil;
    }

    struct StockPrice {
        uint256 nativePrice;
        uint64 updatedAt;
        uint64 validUntil;
        bytes32 feedId;
    }

    struct StockUpdate {
        bytes32 stockId;
        uint256 nativePrice;
        uint64 timestamp;
        uint64 validUntil;
    }

    struct FxUpdate {
        bytes3 currency;
        uint256 rate;
        uint64 timestamp;
        uint64 validUntil;
    }
    IAtlasMarketRegistry public registry;
    mapping(bytes32 => StockPrice) public stockPrices;
    mapping(bytes3 => Observation) public fxRates;
    uint256 public maxPriceAge = 15 minutes;
    error InvalidConfiguration();
    error InvalidPrice();
    error InvalidTimestamp();
    error StalePrice();
    error DisabledStock();
    error InvalidFeed();
    error InvalidCurrency();
    event RegistryBound(address indexed registry);
    event PriceUpdated(
        bytes32 indexed stockId, uint256 nativePrice, bytes32 indexed feedId, uint256 timestamp, uint256 validUntil
    );
    event FxRateUpdated(bytes3 indexed currency, uint256 usdPerNative, uint256 timestamp, uint256 validUntil);
    event MaxPriceAgeUpdated(uint256 seconds_);
    constructor(address admin) AccessControlDefaultAdminRules(1 days, admin) {}

    function bindRegistry(IAtlasMarketRegistry registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(registry) != address(0) || address(registry_).code.length == 0) revert InvalidConfiguration();
        registry = registry_;
        emit RegistryBound(address(registry_));
    }

    function setMaxPriceAge(uint256 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seconds_ < 30 || seconds_ > 1 days) revert InvalidConfiguration();
        maxPriceAge = seconds_;
        emit MaxPriceAgeUpdated(seconds_);
    }

    function updateStockPrice(bytes32 id, uint256 nativePrice, uint64 timestamp, uint64 validUntil)
        external
        onlyRole(PRICE_UPDATER_ROLE)
    {
        _updateStock(id, nativePrice, timestamp, validUntil);
    }

    function updateStockPricesBatch(StockUpdate[] calldata updates) external onlyRole(PRICE_UPDATER_ROLE) {
        if (updates.length == 0 || updates.length > 100) revert InvalidConfiguration();
        for (uint256 i; i < updates.length; ++i) {
            _updateStock(updates[i].stockId, updates[i].nativePrice, updates[i].timestamp, updates[i].validUntil);
        }
    }

    function updateFxRate(bytes3 currency, uint256 rate, uint64 timestamp, uint64 validUntil)
        external
        onlyRole(PRICE_UPDATER_ROLE)
    {
        _updateFx(currency, rate, timestamp, validUntil);
    }

    function updateFxRatesBatch(FxUpdate[] calldata updates) external onlyRole(PRICE_UPDATER_ROLE) {
        if (updates.length == 0 || updates.length > 10) revert InvalidConfiguration();
        for (uint256 i; i < updates.length; ++i) {
            _updateFx(updates[i].currency, updates[i].rate, updates[i].timestamp, updates[i].validUntil);
        }
    }

    function _validate(uint256 value, uint64 timestamp, uint64 validUntil, uint64 previous, uint256 limit)
        private
        view
    {
        if (value == 0 || value > limit) revert InvalidPrice();
        if (
            timestamp == 0 || timestamp > block.timestamp || timestamp <= previous || validUntil < block.timestamp
                || validUntil <= timestamp || validUntil > timestamp + 1 days
                || block.timestamp - timestamp > maxPriceAge
        ) revert InvalidTimestamp();
    }

    function _updateStock(bytes32 id, uint256 nativePrice, uint64 timestamp, uint64 validUntil) private {
        if (address(registry) == address(0)) revert InvalidConfiguration();
        IAtlasMarketRegistry.Stock memory stock = registry.getStock(id);
        if (!stock.active) revert DisabledStock();
        _validate(nativePrice, timestamp, validUntil, stockPrices[id].updatedAt, 1e20);
        stockPrices[id] = StockPrice(nativePrice, timestamp, validUntil, stock.priceFeedId);
        emit PriceUpdated(id, nativePrice, stock.priceFeedId, timestamp, validUntil);
    }

    function _updateFx(bytes3 currency, uint256 rate, uint64 timestamp, uint64 validUntil) private {
        if (currency != "USD" && currency != "INR" && currency != "GBP" && currency != "SGD" && currency != "EUR") {
            revert InvalidCurrency();
        }
        if (currency == "USD" && rate != PRICE_SCALE) revert InvalidPrice();
        _validate(rate, timestamp, validUntil, fxRates[currency].updatedAt, 1e16);
        fxRates[currency] = Observation(rate, timestamp, validUntil);
        emit FxRateUpdated(currency, rate, timestamp, validUntil);
    }

    function _fresh(uint64 timestamp, uint64 until) private view {
        if (
            timestamp == 0 || timestamp > block.timestamp || block.timestamp - timestamp > maxPriceAge
                || block.timestamp > until
        ) revert StalePrice();
    }

    function getStockPriceUSD(bytes32 id) public view returns (uint256 price, uint256 updatedAt, uint256 validUntil) {
        if (address(registry) == address(0)) revert InvalidConfiguration();
        IAtlasMarketRegistry.Stock memory stock = registry.getStock(id);
        if (!stock.active) revert DisabledStock();
        StockPrice memory native_ = stockPrices[id];
        Observation memory fx = fxRates[stock.nativeCurrency];
        if (native_.feedId != stock.priceFeedId) revert InvalidFeed();
        _fresh(native_.updatedAt, native_.validUntil);
        _fresh(fx.updatedAt, fx.validUntil);
        price = Math.mulDiv(native_.nativePrice, fx.value, PRICE_SCALE);
        if (price == 0) revert InvalidPrice();
        updatedAt = Math.min(native_.updatedAt, fx.updatedAt);
        validUntil = Math.min(Math.min(native_.validUntil, fx.validUntil), updatedAt + maxPriceAge);
    }

    function getStockPriceUSDT(bytes32 id) external view returns (uint256) {
        (uint256 price,,) = getStockPriceUSD(id);
        return price / 100;
    }

    function getNativePrice(bytes32 id) external view returns (uint256) {
        return stockPrices[id].nativePrice;
    }

    function getLastUpdated(bytes32 id) external view returns (uint256) {
        return stockPrices[id].updatedAt;
    }
}
