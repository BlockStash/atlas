// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ERC1155SupplyUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice One upgradeable multi-stock ledger per market. Quantities use 18 decimal units.
/// @dev Owner-controlled upgrades are a trust assumption, not a guarantee of immutable custody.
contract AtlasCountryMarket is
    ERC1155SupplyUpgradeable,
    Ownable2StepUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant STOCK_ADMIN_ROLE = keccak256("STOCK_ADMIN_ROLE");
    bytes32 public constant PRICE_UPDATER_ROLE = keccak256("PRICE_UPDATER_ROLE");
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct StockInput {
        bytes32 stockId;
        string ticker;
        string companyName;
        bytes2 country;
        string exchange;
        bytes32 priceFeedId;
    }

    struct Stock {
        bytes32 stockId;
        string ticker;
        string companyName;
        bytes2 country;
        string exchange;
        bytes32 priceFeedId;
        bool active;
    }

    struct Observation {
        uint256 value;
        uint64 updatedAt;
        uint64 validUntil;
    }

    struct PriceInput {
        bytes32 stockId;
        uint256 nativePrice;
    }
    bytes32 public region;
    bytes3 public nativeCurrency;
    address public tradingEngine;
    bool public marketEnabled;
    bool public marketOpen;
    uint64 public marketValidUntil;
    uint256 public maxPriceAge;
    Observation public fxUsd;
    Observation public usdtUsd;
    mapping(bytes32 => Stock) private _stocks;
    mapping(bytes32 => Observation) public nativePrices;
    mapping(bytes32 => bool) private _tickers;
    bytes32[] private _ids;
    uint256[40] private __gap;
    error InvalidConfiguration();
    error InvalidStock();
    error DuplicateStock();
    error UnknownStock();
    error InvalidTimestamp();
    error InvalidPrice();
    error StalePrice();
    error MarketClosed();
    error DisabledStock();
    error UnauthorizedOperator();
    error ApprovalRequired();
    event StockOnboarded(bytes32 indexed stockId, string ticker);
    event StockUpdated(bytes32 indexed stockId, bool active);
    event PricesPublished(uint256 count, uint256 fxUsd, uint256 usdtUsd, uint256 timestamp, uint256 validUntil);
    event MarketUpdated(bool enabled, bool open, uint256 validUntil);
    event TradingEngineUpdated(address indexed previousEngine, address indexed engine);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, bytes32 region_, bytes3 currency_) external initializer {
        if (region_ == 0 || !validCurrency(currency_)) revert InvalidConfiguration();
        __ERC1155_init("");
        __ERC1155Supply_init();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __AccessControl_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        region = region_;
        nativeCurrency = currency_;
        maxPriceAge = 900;
    }
    modifier operator(bytes32 role) {
        if (msg.sender != owner() && !hasRole(ADMIN_ROLE, msg.sender) && !hasRole(role, msg.sender)) {
            revert UnauthorizedOperator();
        }
        _;
    }
    modifier onlyEngine() {
        if (msg.sender != tradingEngine || msg.sender == address(0)) revert UnauthorizedOperator();
        _;
    }

    function grantRole(bytes32 role, address account) public override onlyOwner {
        if (!_businessRole(role) || account == address(0)) revert InvalidConfiguration();
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) public override onlyOwner {
        _revokeRole(role, account);
    }

    function _businessRole(bytes32 role) private pure returns (bool) {
        return role == ADMIN_ROLE || role == STOCK_ADMIN_ROLE || role == PRICE_UPDATER_ROLE || role == MARKET_ADMIN_ROLE
            || role == PAUSER_ROLE;
    }

    function renounceOwnership() public view override onlyOwner {
        revert InvalidConfiguration();
    }
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function version() external pure virtual returns (uint256) {
        return 1;
    }

    function setTradingEngine(address engine) external onlyOwner {
        if (engine.code.length == 0) revert InvalidConfiguration();
        emit TradingEngineUpdated(tradingEngine, engine);
        tradingEngine = engine;
    }

    function onboardStocks(StockInput[] calldata inputs) external operator(STOCK_ADMIN_ROLE) {
        if (inputs.length == 0 || inputs.length > 100) revert InvalidStock();
        for (uint256 i; i < inputs.length; ++i) {
            StockInput calldata s = inputs[i];
            bytes32 key = keccak256(abi.encode(s.exchange, s.ticker));
            if (
                s.stockId == 0 || bytes(s.ticker).length == 0 || bytes(s.ticker).length > 24
                    || bytes(s.companyName).length == 0 || bytes(s.companyName).length > 100 || s.country == 0
                    || bytes(s.exchange).length == 0 || bytes(s.exchange).length > 40 || s.priceFeedId == 0
            ) revert InvalidStock();
            if (_stocks[s.stockId].stockId != 0 || _tickers[key]) revert DuplicateStock();
            _tickers[key] = true;
            _stocks[s.stockId] = Stock(s.stockId, s.ticker, s.companyName, s.country, s.exchange, s.priceFeedId, true);
            _ids.push(s.stockId);
            emit StockOnboarded(s.stockId, s.ticker);
        }
    }

    function getStock(bytes32 id) public view returns (Stock memory s) {
        s = _stocks[id];
        if (s.stockId == 0) revert UnknownStock();
    }

    function stockCount() external view returns (uint256) {
        return _ids.length;
    }

    function stockIdAt(uint256 index) external view returns (bytes32) {
        return _ids[index];
    }

    function listStockIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids) {
        if (offset >= _ids.length) return new bytes32[](0);
        uint256 count = Math.min(Math.min(limit, 100), _ids.length - offset);
        ids = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _ids[offset + i];
        }
    }

    function setStockActive(bytes32 id, bool active) external operator(STOCK_ADMIN_ROLE) {
        getStock(id);
        _stocks[id].active = active;
        emit StockUpdated(id, active);
    }

    function updateStock(bytes32 id, string calldata name, bytes32 feed) external operator(STOCK_ADMIN_ROLE) {
        getStock(id);
        if (bytes(name).length == 0 || bytes(name).length > 100 || feed == 0) revert InvalidStock();
        if (_stocks[id].priceFeedId != feed) delete nativePrices[id];
        _stocks[id].companyName = name;
        _stocks[id].priceFeedId = feed;
        emit StockUpdated(id, _stocks[id].active);
    }

    function setMarket(bool enabled, bool open, uint64 validUntil) external operator(MARKET_ADMIN_ROLE) {
        if (validUntil <= block.timestamp || validUntil > block.timestamp + 1 days) revert InvalidTimestamp();
        marketEnabled = enabled;
        marketOpen = open;
        marketValidUntil = validUntil;
        emit MarketUpdated(enabled, open, validUntil);
    }

    function isMarketOpen() public view returns (bool) {
        return !paused() && marketEnabled && marketOpen && block.timestamp <= marketValidUntil;
    }

    function setMaxPriceAge(uint256 age) external onlyOwner {
        if (age < 30 || age > 1 days) revert InvalidConfiguration();
        maxPriceAge = age;
    }

    function pause() external operator(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external operator(PAUSER_ROLE) {
        _unpause();
    }

    function _time(uint64 observed, uint64 until) private view {
        if (
            observed == 0 || observed > block.timestamp || until <= block.timestamp || until <= observed
                || until > observed + 1 days || block.timestamp - observed > maxPriceAge
        ) revert InvalidTimestamp();
    }

    /// @notice Atomic native prices + USD/native + USD/USDT observation. FX convention is USD per unit.
    function publishPrices(
        PriceInput[] calldata inputs,
        uint256 fxUsd8,
        uint256 usdtUsd8,
        uint64 observed,
        uint64 until
    ) external operator(PRICE_UPDATER_ROLE) {
        if (
            inputs.length == 0 || inputs.length > 100 || fxUsd8 == 0 || fxUsd8 > 1e16 || usdtUsd8 < 1e6
                || usdtUsd8 > 1e10 || (nativeCurrency == "USD" && fxUsd8 != 1e8)
        ) revert InvalidPrice();
        _time(observed, until);
        if (observed < fxUsd.updatedAt || observed < usdtUsd.updatedAt) revert InvalidTimestamp();
        fxUsd = Observation(fxUsd8, observed, until);
        usdtUsd = Observation(usdtUsd8, observed, until);
        for (uint256 i; i < inputs.length; ++i) {
            PriceInput calldata p = inputs[i];
            getStock(p.stockId);
            if (!_stocks[p.stockId].active) revert DisabledStock();
            if (p.nativePrice == 0 || p.nativePrice > 1e20) revert InvalidPrice();
            if (observed <= nativePrices[p.stockId].updatedAt) revert InvalidTimestamp();
            nativePrices[p.stockId] = Observation(p.nativePrice, observed, until);
        }
        emit PricesPublished(inputs.length, fxUsd8, usdtUsd8, observed, until);
    }

    function _fresh(Observation memory p) private view {
        if (
            p.updatedAt == 0 || p.updatedAt > block.timestamp || block.timestamp > p.validUntil
                || block.timestamp - p.updatedAt > maxPriceAge
        ) revert StalePrice();
    }

    function getStockPriceUSDT(bytes32 id)
        external
        view
        returns (uint256 price, uint256 updatedAt, uint256 validUntil, uint256 usdPrice)
    {
        Stock memory s = getStock(id);
        if (!s.active) revert DisabledStock();
        Observation memory p = nativePrices[id];
        _fresh(p);
        _fresh(fxUsd);
        _fresh(usdtUsd);
        usdPrice = Math.mulDiv(p.value, fxUsd.value, 1e8);
        price = Math.mulDiv(usdPrice, 1e8, usdtUsd.value);
        if (price == 0) revert InvalidPrice();
        updatedAt = Math.min(p.updatedAt, Math.min(fxUsd.updatedAt, usdtUsd.updatedAt));
        validUntil =
            Math.min(Math.min(p.validUntil, Math.min(fxUsd.validUntil, usdtUsd.validUntil)), updatedAt + maxPriceAge);
    }

    function mintStock(address to, bytes32 id, uint256 quantity) external onlyEngine whenNotPaused {
        getStock(id);
        if (!_stocks[id].active || quantity == 0) revert InvalidStock();
        _mint(to, uint256(id), quantity, "");
    }

    function burnStock(address from, bytes32 id, uint256 quantity) external onlyEngine whenNotPaused {
        if (!isApprovedForAll(from, msg.sender)) revert ApprovalRequired();
        _burn(from, uint256(id), quantity);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 id)
        public
        view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(id);
    }

    function validCurrency(bytes3 currency) public pure returns (bool) {
        return currency == "INR" || currency == "USD" || currency == "GBP" || currency == "SGD" || currency == "EUR";
    }
}
