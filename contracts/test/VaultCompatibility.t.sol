// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {AtlasVault} from "../src/AtlasVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract NoReturnUSDT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address to, uint256 amount) external {
        allowance[msg.sender][to] = amount;
    }

    function transfer(address to, uint256 amount) external {
        _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract FeeUSDT is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee);
            amount -= fee;
        }
        super._update(from, to, amount);
    }
}

contract ReentrantUSDT is ERC20 {
    address public target;
    bool public guarded;
    constructor() ERC20("Callback", "CALL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address a) external {
        target = a;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (target != address(0) && to == target && from != address(0)) {
            (bool success, bytes memory reason) =
                target.call(abi.encodeWithSignature("deposit(uint256,address)", 1, address(this)));
            guarded = !success && reason.length >= 4
                && keccak256(reason) == keccak256(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        }
        super._update(from, to, amount);
    }
}

contract VaultCompatibilityTest is TestBase {
    function testNoReturnUSDTUsesSafeERC20() public {
        NoReturnUSDT token = new NoReturnUSDT();
        AtlasVault vault = new AtlasVault(IERC20(address(token)), address(this));
        token.mint(address(this), 100e6);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6, address(this));
        vault.redeem(vault.balanceOf(address(this)), address(this), address(this));
        eq(token.balanceOf(address(this)), 100e6);
    }

    function testFeeOnTransferTokenIsRejectedAtomically() public {
        FeeUSDT token = new FeeUSDT();
        AtlasVault vault = new AtlasVault(IERC20(address(token)), address(this));
        token.mint(address(this), 100e6);
        token.approve(address(vault), 100e6);
        vm.expectRevert(AtlasVault.UnsupportedTransfer.selector);
        vault.deposit(100e6, address(this));
        eq(vault.totalSupply(), 0);
        eq(token.balanceOf(address(this)), 100e6);
    }

    function testCallbackCannotReenterVault() public {
        ReentrantUSDT token = new ReentrantUSDT();
        AtlasVault vault = new AtlasVault(IERC20(address(token)), address(this));
        token.setTarget(address(vault));
        token.mint(address(this), 100e6);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6, address(this));
        ok(token.guarded());
        eq(vault.totalAssets(), 100e6);
    }
}
