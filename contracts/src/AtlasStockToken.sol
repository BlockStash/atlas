// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Demo synthetic exposure only; no legal claim on company shares.
contract AtlasStockToken is ERC20, AccessControlDefaultAdminRules {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public immutable stockId;
    error InvalidStockId();

    constructor(bytes32 id, string memory company, string memory ticker, address admin)
        ERC20(string.concat("Atlas Synthetic ", company), string.concat("a", ticker))
        AccessControlDefaultAdminRules(1 days, admin)
    {
        if (id == bytes32(0)) revert InvalidStockId();
        stockId = id;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        if (from != msg.sender) _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}
