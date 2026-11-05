// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {AtlasStockToken} from "./AtlasStockToken.sol";
import {AtlasMarketRegistry} from "./AtlasMarketRegistry.sol";
import {IAtlasMarketRegistry} from "./interfaces/IAtlasMarketRegistry.sol";

contract AtlasStockFactory is AccessControlDefaultAdminRules {
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    AtlasMarketRegistry public immutable registry;
    address public stockAdmin;
    error InvalidConfiguration();
    event StockDeployed(bytes32 indexed stockId, address indexed token);
    event StockAdminUpdated(address indexed admin);

    constructor(address admin, AtlasMarketRegistry registry_, address stockAdmin_)
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (address(registry_).code.length == 0 || stockAdmin_ == address(0)) revert InvalidConfiguration();
        registry = registry_;
        stockAdmin = stockAdmin_;
    }

    /// @notice Applies to future stock deployments; existing tokens keep their independent administrators.
    function setStockAdmin(address admin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (admin == address(0)) revert InvalidConfiguration();
        stockAdmin = admin;
        emit StockAdminUpdated(admin);
    }

    function createStock(IAtlasMarketRegistry.Stock calldata metadata)
        external
        onlyRole(MARKET_ADMIN_ROLE)
        returns (address token)
    {
        if (metadata.token != address(0)) revert InvalidConfiguration();
        token = address(new AtlasStockToken(metadata.stockId, metadata.companyName, metadata.ticker, stockAdmin));
        IAtlasMarketRegistry.Stock memory stock = metadata;
        stock.token = token;
        registry.addStock(stock);
        emit StockDeployed(stock.stockId, token);
    }
}
