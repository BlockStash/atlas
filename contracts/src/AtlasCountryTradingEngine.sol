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
import {AtlasCountryMarket} from "./AtlasCountryMarket.sol";

/// @notice Fully funded synthetic spot demo. No leverage and no promise of unlimited market-price redemption.
contract AtlasCountryTradingEngine is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant BPS = 10_000;
    IAtlasVault public immutable vault;
    mapping(address => bool) public allowedCountry;
    address[] public countries;
    address public immutable settlementToken;
    address public immutable treasury;
    uint256 public tradingFeeBps = 10;
    uint256 public totalReservedShares;
    mapping(bytes32 => uint256) private _reservedShares;
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

    constructor(address admin, IAtlasVault vault_, address[] memory countries_, address treasury_)
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (
            address(vault_).code.length == 0 || countries_.length != 5 || treasury_ == address(0)
                || treasury_ == address(this)
        ) revert InvalidConfiguration();
        vault = vault_;
        for (uint256 i; i < countries_.length; ++i) {
            address country = countries_[i];
            if (country.code.length == 0 || allowedCountry[country]) revert InvalidConfiguration();
            allowedCountry[country] = true;
            countries.push(country);
        }
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

    function _stock(address country, bytes32 id) private view {
        if (!allowedCountry[country]) revert InvalidConfiguration();
        AtlasCountryMarket market = AtlasCountryMarket(country);
        if (!market.getStock(id).active) revert DisabledStock();
        if (!market.isMarketOpen()) revert MarketClosed();
    }

    function assetKey(address country, bytes32 id) public pure returns (bytes32) {
        return keccak256(abi.encode(country, id));
    }

    function reservedShares(address country, bytes32 id) public view returns (uint256) {
        return _reservedShares[assetKey(country, id)];
    }

    function _value(address country, bytes32 id, uint256 quantity, bool buying) private view returns (uint256 gross) {
        if (quantity == 0) revert InvalidQuantity();
        _stock(country, id);
        (uint256 price,,,) = AtlasCountryMarket(country).getStockPriceUSDT(id);
        gross = Math.mulDiv(quantity, price, 1e20, buying ? Math.Rounding.Ceil : Math.Rounding.Floor);
        if (gross == 0) revert InvalidQuantity();
    }

    function quoteBuy(address country, bytes32 id, uint256 quantity)
        public
        view
        returns (uint256 assets, uint256 fee, uint256 shares)
    {
        assets = _value(country, id, quantity, true);
        fee = Math.mulDiv(assets, tradingFeeBps, BPS, Math.Rounding.Ceil);
        shares = vault.previewWithdraw(assets) + (fee == 0 ? 0 : vault.previewWithdraw(fee));
    }

    /// @return assets Gross USDT units before the fee. Returned shares represent net proceeds.
    function quoteSell(address country, bytes32 id, uint256 quantity)
        public
        view
        returns (uint256 assets, uint256 fee, uint256 shares)
    {
        assets = _value(country, id, quantity, false);
        fee = Math.mulDiv(assets, tradingFeeBps, BPS, Math.Rounding.Ceil);
        if (assets <= fee) revert InvalidQuantity();
        shares = vault.previewDeposit(assets - fee);
        if (shares == 0) revert InvalidQuantity();
    }

    function buy(address country, bytes32 id, uint256 quantity, uint256 maxShares, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert Expired();
        _stock(country, id);
        (uint256 assets, uint256 fee, uint256 spent) = quoteBuy(country, id, quantity);
        if (spent > maxShares) revert Slippage();
        shares = spent;
        uint256 reserve = vault.previewWithdraw(assets);
        uint256 feeShares = spent - reserve;
        _reservedShares[assetKey(country, id)] += reserve;
        totalReservedShares += reserve;
        cumulativeBuyAssets[msg.sender] += assets + fee;
        (uint256 price,,,) = AtlasCountryMarket(country).getStockPriceUSDT(id);
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), spent);
        if (feeShares > 0) IERC20(address(vault)).safeTransfer(treasury, feeShares);
        AtlasCountryMarket(country).mintStock(msg.sender, id, quantity);
        emit StockPurchased(msg.sender, assetKey(country, id), quantity, assets, fee, spent);
        emit TradeExecuted(msg.sender, assetKey(country, id), true, quantity, price, spent);
    }

    function sell(address country, bytes32 id, uint256 quantity, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert Expired();
        _stock(country, id);
        (uint256 assets, uint256 fee, uint256 returned) = quoteSell(country, id, quantity);
        if (returned < minShares) revert Slippage();
        shares = returned;
        uint256 feeShares = fee == 0 ? 0 : vault.previewDeposit(fee);
        uint256 total = returned + feeShares;
        if (_reservedShares[assetKey(country, id)] < total) revert InsufficientLiquidity();
        _reservedShares[assetKey(country, id)] -= total;
        totalReservedShares -= total;
        cumulativeSellAssets[msg.sender] += assets - fee;
        AtlasCountryMarket(country).burnStock(msg.sender, id, quantity);
        IERC20(address(vault)).safeTransfer(msg.sender, returned);
        if (feeShares > 0) IERC20(address(vault)).safeTransfer(treasury, feeShares);
        (uint256 price,,,) = AtlasCountryMarket(country).getStockPriceUSDT(id);
        emit StockSold(msg.sender, assetKey(country, id), quantity, assets, fee, returned);
        emit TradeExecuted(msg.sender, assetKey(country, id), false, quantity, price, returned);
    }

    /// @notice Voluntary, non-refundable inventory liquidity; cannot be withdrawn by any admin.
    function fundReserve(address country, bytes32 id, uint256 shares) external nonReentrant {
        if (!allowedCountry[country]) revert InvalidConfiguration();
        AtlasCountryMarket(country).getStock(id);
        if (shares == 0) revert InvalidQuantity();
        _reservedShares[assetKey(country, id)] += shares;
        totalReservedShares += shares;
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        emit ReserveFunded(msg.sender, assetKey(country, id), shares);
    }

    function availableTradingAssets(address user) external view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(user));
    }

    function reserveAssets(address country, bytes32 id) external view returns (uint256) {
        return vault.convertToAssets(_reservedShares[assetKey(country, id)]);
    }
}
