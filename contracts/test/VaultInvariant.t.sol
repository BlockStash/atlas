// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {AtlasUSDT} from "../src/AtlasUSDT.sol";
import {AtlasVault} from "../src/AtlasVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract VaultHandler is TestBase {
    AtlasUSDT public token;
    AtlasVault public vault;
    address[3] public actors = [address(0x111), address(0x222), address(0x333)];

    constructor(AtlasUSDT t, AtlasVault v) {
        token = t;
        vault = v;
    }

    function deposit(uint96 seed, uint8 who) external {
        address user = actors[who % 3];
        uint256 amount = bound(seed, 1, 1e12);
        uint256 minimum = vault.previewMint(1);
        if (amount < minimum) amount = minimum;
        token.mint(user, amount);
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount, user);
        vm.stopPrank();
    }

    function redeem(uint96 seed, uint8 who) external {
        address user = actors[who % 3];
        uint256 balance = vault.balanceOf(user);
        if (balance == 0) return;
        vm.prank(user);
        vault.redeem(bound(seed, 1, balance), user, user);
    }

    function donate(uint64 seed) external {
        token.mint(address(vault), bound(seed, 1, 1e10));
    }

    function transferShares(uint96 seed, uint8 from, uint8 to) external {
        address user = actors[from % 3];
        uint256 balance = vault.balanceOf(user);
        if (balance == 0) return;
        vm.prank(user);
        ok(vault.transfer(actors[to % 3], bound(seed, 1, balance)));
    }
}

contract VaultInvariantTest is TestBase {
    AtlasUSDT token;
    AtlasVault vault;
    VaultHandler handler;

    function setUp() public {
        token = new AtlasUSDT(address(this));
        vault = new AtlasVault(IERC20(address(token)), address(this));
        handler = new VaultHandler(token, vault);
        token.grantRole(token.MINTER_ROLE(), address(handler));
    }

    // Foundry probes optional invariant-target array getters; empty ABI arrays are valid for each.
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(new address[](0));
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantClaimsNeverExceedCustody() public view {
        uint256 claims;
        uint256 shares;
        for (uint256 i; i < 3; i++) {
            uint256 balance = vault.balanceOf(handler.actors(i));
            claims += vault.previewRedeem(balance);
            shares += balance;
        }
        ok(claims <= vault.totalAssets());
        eq(shares, vault.totalSupply());
        ok(vault.convertToAssets(vault.totalSupply()) <= vault.totalAssets());
    }
}
