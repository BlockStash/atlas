// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Custody-only vault. No admin sweep, asset replacement, or engine asset-transfer privilege.
contract AtlasVault is ERC4626, AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    mapping(address => uint256) public cumulativeDeposits;
    mapping(address => bool) public hasDeposited;
    uint256 public uniqueDepositors;
    error Slippage();
    error InvalidSettlementToken();
    error UnsupportedTransfer();
    error ZeroDeposit();

    constructor(IERC20 token, address admin)
        ERC20("Atlas Vault Share", "aUSDT")
        ERC4626(token)
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (address(token).code.length == 0 || IERC20Metadata(address(token)).decimals() != 6) {
            revert InvalidSettlementToken();
        }
    }

    /// Six extra raw-share decimals preserve 1 human-readable share = 1 USDT initially, with virtual-share protection.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function maxDeposit(address owner) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(owner);
    }

    function maxMint(address owner) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(owner);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    function withdrawWithMaxShares(uint256 assets, address receiver, address owner, uint256 maxShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.withdraw(assets, receiver, owner);
        if (shares > maxShares) revert Slippage();
    }

    function depositWithMinShares(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        shares = super.deposit(assets, receiver);
        if (shares < minShares) revert Slippage();
    }

    function redeemWithMinAssets(uint256 shares, address receiver, address owner, uint256 minAssets)
        external
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.redeem(shares, receiver, owner);
        if (assets < minAssets) revert Slippage();
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (assets == 0 || shares == 0) revert ZeroDeposit();
        uint256 beforeBalance = totalAssets();
        super._deposit(caller, receiver, assets, shares);
        if (totalAssets() - beforeBalance != assets) revert UnsupportedTransfer();
        if (!hasDeposited[receiver]) {
            hasDeposited[receiver] = true;
            ++uniqueDepositors;
        }
        cumulativeDeposits[receiver] += assets;
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 beforeAssets = totalAssets();
        uint256 beforeReceiver = IERC20(asset()).balanceOf(receiver);
        super._withdraw(caller, receiver, owner, assets, shares);
        if (beforeAssets - totalAssets() != assets || IERC20(asset()).balanceOf(receiver) - beforeReceiver != assets) {
            revert UnsupportedTransfer();
        }
    }
}
