// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAtlasVault} from "./interfaces/IAtlasVault.sol";
import {IAtlasStockToken} from "./interfaces/IAtlasStockToken.sol";
import {IAtlasMarketRegistry} from "./interfaces/IAtlasMarketRegistry.sol";
import {IAtlasPriceEngine} from "./interfaces/IAtlasPriceEngine.sol";
import {IAtlasTradingEngine} from "./interfaces/IAtlasTradingEngine.sol";

/// @notice Fully funded synthetic spot demo. No leverage and no promise of unlimited market-price redemption.
contract AtlasTradingEngine is IAtlasTradingEngine, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant BPS = 10_000;
    IAtlasVault public immutable vault;
    IAtlasMarketRegistry public immutable registry;
    IAtlasPriceEngine public immutable priceEngine;
    address public immutable settlementToken;
    address public immutable treasury;
    uint256 public tradingFeeBps = 10;
    uint256 public totalReservedShares;
    mapping(bytes32 => uint256) public reservedShares;
    mapping(address => uint256) public cumulativeBuyAssets;
    mapping(address => uint256) public cumulativeSellAssets;
    error InvalidConfiguration();
    error InvalidQuantity();
    error Slippage();
    error Expired();
    error InsufficientLiquidity();
    error MarketClosed();
    error DisabledStock();
    event StockPurchased(
        address indexed user, bytes32 indexed stockId, uint256 quantity, uint256 assets, uint256 fee, uint256 shares
    );
    event StockSold(
        address indexed user, bytes32 indexed stockId, uint256 quantity, uint256 assets, uint256 fee, uint256 shares
    );
    event TradeExecuted(
        address indexed user, bytes32 indexed stockId, bool buy, uint256 quantity, uint256 usdPrice, uint256 shares
    );
    event ReserveFunded(address indexed provider, bytes32 indexed stockId, uint256 shares);
    event TradingFeeUpdated(uint256 feeBps);

    constructor(
        address admin,
        IAtlasVault vault_,
        IAtlasMarketRegistry registry_,
        IAtlasPriceEngine priceEngine_,
        address treasury_
    ) AccessControlDefaultAdminRules(1 days, admin) {
        if (
            address(vault_).code.length == 0 || address(registry_).code.length == 0
                || address(priceEngine_).code.length == 0 || treasury_ == address(0) || treasury_ == address(this)
        ) revert InvalidConfiguration();
        vault = vault_;
        registry = registry_;
        priceEngine = priceEngine_;
        treasury = treasury_;
        settlementToken = vault_.asset();
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setTradingFeeBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidConfiguration();
        tradingFeeBps = bps;
        emit TradingFeeUpdated(bps);
    }

    function _stock(bytes32 id) private view returns (IAtlasMarketRegistry.Stock memory stock) {
        stock = registry.getStock(id);
        if (!stock.active) revert DisabledStock();
        if (!registry.isMarketOpen(stock.region)) revert MarketClosed();
    }

    function _value(bytes32 id, uint256 quantity, bool buying) private view returns (uint256 gross) {
        if (quantity == 0) revert InvalidQuantity();
        _stock(id);
        (uint256 price,,) = priceEngine.getStockPriceUSD(id);
        gross = Math.mulDiv(quantity, price, 1e20, buying ? Math.Rounding.Ceil : Math.Rounding.Floor);
        if (gross == 0) revert InvalidQuantity();
    }

    function quoteBuy(bytes32 id, uint256 quantity) public view returns (uint256 assets, uint256 fee, uint256 shares) {
        assets = _value(id, quantity, true);
        fee = Math.mulDiv(assets, tradingFeeBps, BPS, Math.Rounding.Ceil);
        shares = vault.previewWithdraw(assets) + (fee == 0 ? 0 : vault.previewWithdraw(fee));
    }

    /// @return assets Gross USDT units before the fee. Returned shares represent net proceeds.
    function quoteSell(bytes32 id, uint256 quantity) public view returns (uint256 assets, uint256 fee, uint256 shares) {
        assets = _value(id, quantity, false);
        fee = Math.mulDiv(assets, tradingFeeBps, BPS, Math.Rounding.Ceil);
        if (assets <= fee) revert InvalidQuantity();
        shares = vault.previewDeposit(assets - fee);
        if (shares == 0) revert InvalidQuantity();
    }

    function buy(bytes32 id, uint256 quantity, uint256 maxShares, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert Expired();
        IAtlasMarketRegistry.Stock memory stock = _stock(id);
        (uint256 assets, uint256 fee, uint256 spent) = quoteBuy(id, quantity);
        if (spent > maxShares) revert Slippage();
        shares = spent;
        uint256 reserve = vault.previewWithdraw(assets);
        uint256 feeShares = spent - reserve;
        reservedShares[id] += reserve;
        totalReservedShares += reserve;
        cumulativeBuyAssets[msg.sender] += assets + fee;
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), spent);
        if (feeShares > 0) IERC20(address(vault)).safeTransfer(treasury, feeShares);
        IAtlasStockToken(stock.token).mint(msg.sender, quantity);
        (uint256 price,,) = priceEngine.getStockPriceUSD(id);
        emit StockPurchased(msg.sender, id, quantity, assets, fee, spent);
        emit TradeExecuted(msg.sender, id, true, quantity, price, spent);
    }

    function sell(bytes32 id, uint256 quantity, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert Expired();
        IAtlasMarketRegistry.Stock memory stock = _stock(id);
        (uint256 assets, uint256 fee, uint256 returned) = quoteSell(id, quantity);
        if (returned < minShares) revert Slippage();
        shares = returned;
        uint256 feeShares = fee == 0 ? 0 : vault.previewDeposit(fee);
        uint256 total = returned + feeShares;
        if (reservedShares[id] < total) revert InsufficientLiquidity();
        reservedShares[id] -= total;
        totalReservedShares -= total;
        cumulativeSellAssets[msg.sender] += assets - fee;
        IAtlasStockToken(stock.token).burnFrom(msg.sender, quantity);
        IERC20(address(vault)).safeTransfer(msg.sender, returned);
        if (feeShares > 0) IERC20(address(vault)).safeTransfer(treasury, feeShares);
        (uint256 price,,) = priceEngine.getStockPriceUSD(id);
        emit StockSold(msg.sender, id, quantity, assets, fee, returned);
        emit TradeExecuted(msg.sender, id, false, quantity, price, returned);
    }

    /// @notice Voluntary, non-refundable inventory liquidity; cannot be withdrawn by any admin.
    function fundReserve(bytes32 id, uint256 shares) external nonReentrant {
        registry.getStock(id);
        if (shares == 0) revert InvalidQuantity();
        reservedShares[id] += shares;
        totalReservedShares += shares;
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        emit ReserveFunded(msg.sender, id, shares);
    }

    function availableTradingAssets(address user) external view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(user));
    }

    function reserveAssets(bytes32 id) external view returns (uint256) {
        return vault.convertToAssets(reservedShares[id]);
    }
}
