// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {AtlasUSDT} from "../src/AtlasUSDT.sol";
import {AtlasVault} from "../src/AtlasVault.sol";
import {AtlasStockToken} from "../src/AtlasStockToken.sol";
import {AtlasStockFactory} from "../src/AtlasStockFactory.sol";
import {AtlasMarketRegistry} from "../src/AtlasMarketRegistry.sol";
import {AtlasPriceEngine} from "../src/AtlasPriceEngine.sol";
import {AtlasTradingEngine} from "../src/AtlasTradingEngine.sol";
import {IAtlasMarketRegistry} from "../src/interfaces/IAtlasMarketRegistry.sol";
import {IAtlasVault} from "../src/interfaces/IAtlasVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AtlasProtocolTest is TestBase {
    AtlasUSDT token;
    AtlasVault vault;
    AtlasStockToken stock;
    AtlasStockFactory factory;
    AtlasMarketRegistry registry;
    AtlasPriceEngine prices;
    AtlasTradingEngine engine;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address treasury = address(0xFEE);
    address updater = address(0x1234);
    bytes32 constant ID = keccak256("usa:NASDAQ:AAPL");

    function setUp() public {
        vm.warp(1800000000);
        token = new AtlasUSDT(address(this));
        token.grantRole(token.MINTER_ROLE(), address(this));
        token.grantRole(token.PAUSER_ROLE(), address(this));
        vault = new AtlasVault(IERC20(address(token)), address(this));
        vault.grantRole(vault.PAUSER_ROLE(), address(this));
        prices = new AtlasPriceEngine(address(this));
        registry = new AtlasMarketRegistry(address(this));
        prices.bindRegistry(registry);
        registry.grantRole(registry.MARKET_ADMIN_ROLE(), address(this));
        registry.setMarket("usa", true, true, uint64(block.timestamp + 86400));
        factory = new AtlasStockFactory(address(this), registry, address(this));
        registry.grantRole(registry.FACTORY_ROLE(), address(factory));
        factory.grantRole(factory.MARKET_ADMIN_ROLE(), address(this));
        stock = AtlasStockToken(factory.createStock(metadata(ID, "AAPL", "USD")));
        engine = new AtlasTradingEngine(address(this), IAtlasVault(address(vault)), registry, prices, treasury);
        stock.grantRole(stock.MINTER_ROLE(), address(engine));
        stock.grantRole(stock.BURNER_ROLE(), address(engine));
        engine.grantRole(engine.PAUSER_ROLE(), address(this));
        prices.grantRole(prices.PRICE_UPDATER_ROLE(), updater);
        price(150e8);
        deposit(alice, 100000e6);
        deposit(bob, 100000e6);
    }

    function metadata(bytes32 id, string memory ticker, bytes3 currency)
        internal
        pure
        returns (IAtlasMarketRegistry.Stock memory)
    {
        return IAtlasMarketRegistry.Stock(
            id,
            address(0),
            ticker,
            "Demo Company",
            "US",
            "usa",
            "NASDAQ",
            currency,
            keccak256(abi.encode(id, "feed")),
            true
        );
    }

    function deposit(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(vault), amount);
        vault.deposit(amount, who);
        vault.approve(address(engine), type(uint256).max);
        stock.approve(address(engine), type(uint256).max);
        vm.stopPrank();
    }

    function price(uint256 p) internal {
        vm.startPrank(updater);
        prices.updateFxRate("USD", 1e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        prices.updateStockPrice(ID, p, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.stopPrank();
    }

    function buy(uint256 q) internal {
        vm.prank(alice);
        engine.buy(ID, q, type(uint256).max, block.timestamp);
    }

    function testTokenDecimalsAndNoImplicitMinter() public {
        eq(token.decimals(), 6);
        AtlasUSDT other = new AtlasUSDT(address(this));
        vm.expectRevert();
        other.mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1);
    }

    function testTokenTransferApproveAndBurn() public {
        token.mint(alice, 300e6);
        vm.prank(alice);
        token.approve(bob, 200e6);
        vm.prank(bob);
        ok(token.transferFrom(alice, bob, 200e6));
        vm.prank(bob);
        token.burn(100e6);
        eq(token.allowance(alice, bob), 0);
    }

    function testTokenPause() public {
        token.mint(alice, 1);
        token.pause();
        vm.prank(alice);
        (bool success, bytes memory reason) = address(token).call(abi.encodeCall(token.transfer, (bob, 1)));
        ok(!success);
        ok(keccak256(reason) == keccak256(abi.encodeWithSignature("EnforcedPause()")));
        token.unpause();
        vm.prank(alice);
        ok(token.transfer(bob, 1));
    }

    function testVaultProportionalDonation() public {
        eq(vault.decimals(), 12);
        eq(vault.balanceOf(alice), 100000e12);
        token.mint(address(vault), 20000e6);
        ok(vault.convertToAssets(vault.balanceOf(alice)) > 109999e6);
        eq(vault.uniqueDepositors(), 2);
    }

    function testFactoryFutureStockAdministratorCanRotate() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.setStockAdmin(bob);
        vm.expectRevert(AtlasStockFactory.InvalidConfiguration.selector);
        factory.setStockAdmin(address(0));
        factory.setStockAdmin(bob);
        AtlasStockToken next = AtlasStockToken(factory.createStock(metadata(keccak256("NEW"), "NEW", "USD")));
        eq(uint256(uint160(next.defaultAdmin())), uint256(uint160(bob)));
        eq(uint256(uint160(stock.defaultAdmin())), uint256(uint160(address(this))));
        ok(!next.hasRole(next.MINTER_ROLE(), bob));
    }

    function testDonationBeforeFirstDepositRejectsZeroShares() public {
        AtlasVault fresh = new AtlasVault(IERC20(address(token)), address(this));
        token.mint(address(fresh), 10_000e6);
        token.mint(address(this), 1e6);
        token.approve(address(fresh), 1e6);
        vm.expectRevert(AtlasVault.ZeroDeposit.selector);
        fresh.deposit(1, address(this));
        eq(fresh.totalSupply(), 0);
        uint256 shares = fresh.deposit(1e6, address(this));
        ok(shares > 0);
        ok(fresh.previewRedeem(shares) <= 1e6);
    }

    function testVaultWithdrawRedeemAndMint() public {
        vm.startPrank(alice);
        vault.withdraw(500e6, alice, alice);
        vault.redeem(100e12, alice, alice);
        token.approve(address(vault), 1000e6);
        eq(vault.previewMint(100e12), 100e6);
        vault.mint(100e12, alice);
        vm.stopPrank();
    }

    function testVaultPauseAllowsExits() public {
        vault.pause();
        eq(vault.maxDeposit(alice), 0);
        eq(vault.maxMint(alice), 0);
        vm.startPrank(alice);
        vm.expectRevert();
        vault.deposit(1, alice);
        vault.withdraw(1e6, alice, alice);
        vm.stopPrank();
    }

    function testAdminCannotWithdrawUserAssets() public {
        vm.expectRevert();
        vault.withdraw(1e6, address(this), alice);
    }

    function testVaultSlippage() public {
        token.mint(alice, 1e6);
        vm.startPrank(alice);
        token.approve(address(vault), 1e6);
        vm.expectRevert(AtlasVault.Slippage.selector);
        vault.depositWithMinShares(1e6, alice, type(uint256).max);
        vm.stopPrank();
    }

    function testDuplicateStockIdAndTicker() public {
        vm.expectRevert();
        factory.createStock(metadata(ID, "AAPL", "USD"));
        vm.expectRevert();
        factory.createStock(metadata(keccak256("other"), "AAPL", "USD"));
    }

    function testStockCreationAndSupplyRoles() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.createStock(metadata(keccak256("new"), "NEW", "USD"));
        vm.prank(alice);
        vm.expectRevert();
        stock.mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert();
        stock.burnFrom(bob, 1);
    }

    function testFxConversion() public {
        bytes32 india = keccak256("RELIANCE");
        factory.createStock(metadata(india, "RELIANCE", "INR"));
        vm.startPrank(updater);
        prices.updateFxRate("INR", 1204819, uint64(block.timestamp), uint64(block.timestamp + 900));
        prices.updateStockPrice(india, 2850e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.stopPrank();
        (uint256 p,,) = prices.getStockPriceUSD(india);
        eq(p, 3433734150);
        eq(prices.getStockPriceUSDT(india), 34337341);
    }

    function testPricePermissionsAndValidation() public {
        vm.prank(alice);
        vm.expectRevert();
        prices.updateStockPrice(ID, 1, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.startPrank(updater);
        vm.expectRevert();
        prices.updateFxRate("CNY", 1, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.expectRevert();
        prices.updateFxRate("USD", 2e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.expectRevert();
        prices.updateStockPrice(ID, 0, uint64(block.timestamp + 1), uint64(block.timestamp + 900));
        vm.stopPrank();
    }

    function testStalePriceRejectsTrade() public {
        vm.warp(block.timestamp + 901);
        vm.prank(alice);
        vm.expectRevert(AtlasPriceEngine.StalePrice.selector);
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
    }

    function testFreshStockWithStaleFxRejected() public {
        vm.warp(block.timestamp + 901);
        vm.prank(updater);
        prices.updateStockPrice(ID, 151e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.expectRevert(AtlasPriceEngine.StalePrice.selector);
        prices.getStockPriceUSD(ID);
    }

    function testFeedReplacementInvalidatesOldPrices() public {
        registry.updateStock(ID, "Apple", "NASDAQ", keccak256("newfeed"));
        vm.expectRevert(AtlasPriceEngine.InvalidFeed.selector);
        prices.getStockPriceUSD(ID);
    }

    function testBatchAndTimestampRollback() public {
        vm.warp(block.timestamp + 1);
        AtlasPriceEngine.StockUpdate[] memory batch = new AtlasPriceEngine.StockUpdate[](1);
        batch[0] = AtlasPriceEngine.StockUpdate(ID, 160e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.prank(updater);
        prices.updateStockPricesBatch(batch);
        eq(prices.getNativePrice(ID), 160e8);
        vm.prank(updater);
        vm.expectRevert(AtlasPriceEngine.InvalidTimestamp.selector);
        prices.updateStockPricesBatch(batch);
    }

    function testBuySellFeesAndReserveConservation() public {
        uint256 before = vault.balanceOf(alice);
        buy(10e18);
        eq(stock.balanceOf(alice), 10e18);
        eq(engine.reserveAssets(ID), 1500e6);
        ok(vault.balanceOf(treasury) > 0);
        vm.prank(alice);
        engine.sell(ID, 10e18, 0, block.timestamp);
        eq(stock.balanceOf(alice), 0);
        ok(vault.balanceOf(alice) < before);
        eq(vault.balanceOf(address(engine)), engine.totalReservedShares());
    }

    function testInsufficientBalanceAndApproval() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
        vm.startPrank(alice);
        vault.approve(address(engine), 0);
        vm.expectRevert();
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    function testProfitsNeedInventoryLiquidity() public {
        buy(1e18);
        vm.warp(block.timestamp + 1);
        price(200e8);
        vm.prank(alice);
        vm.expectRevert(AtlasTradingEngine.InsufficientLiquidity.selector);
        engine.sell(ID, 1e18, 0, block.timestamp);
        eq(stock.balanceOf(alice), 1e18);
        vm.prank(bob);
        engine.fundReserve(ID, 100e12);
        vm.prank(alice);
        engine.sell(ID, 1e18, 0, block.timestamp);
        eq(stock.balanceOf(alice), 0);
    }

    function testCannotSellOthersTokens() public {
        buy(1e18);
        vm.prank(bob);
        vm.expectRevert();
        engine.sell(ID, 1e18, 0, block.timestamp);
        eq(stock.balanceOf(alice), 1e18);
    }

    function testDisabledUnknownClosedMarket() public {
        registry.setStockActive(ID, false);
        vm.prank(alice);
        vm.expectRevert();
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
        registry.setStockActive(ID, true);
        registry.setMarket("usa", true, false, uint64(block.timestamp + 600));
        vm.prank(alice);
        vm.expectRevert(AtlasTradingEngine.MarketClosed.selector);
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
        vm.prank(alice);
        vm.expectRevert();
        engine.buy(keccak256("unknown"), 1e18, type(uint256).max, block.timestamp);
    }

    function testPauseDeadlineFeeCapAndSlippage() public {
        engine.pause();
        vm.prank(alice);
        vm.expectRevert();
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp);
        engine.unpause();
        vm.prank(alice);
        vm.expectRevert(AtlasTradingEngine.Expired.selector);
        engine.buy(ID, 1e18, type(uint256).max, block.timestamp - 1);
        vm.prank(alice);
        vm.expectRevert(AtlasTradingEngine.Slippage.selector);
        engine.buy(ID, 1e18, 1, block.timestamp);
        vm.expectRevert();
        engine.setTradingFeeBps(101);
        vm.prank(alice);
        vm.expectRevert();
        engine.setTradingFeeBps(0);
    }

    function testFuzzRoundTripDoesNotCreateShares(uint96 seed) public {
        uint256 q = bound(seed, 1e12, 100e18);
        uint256 before = vault.balanceOf(alice);
        vm.startPrank(alice);
        engine.buy(ID, q, type(uint256).max, block.timestamp);
        engine.sell(ID, q, 0, block.timestamp);
        vm.stopPrank();
        ok(vault.balanceOf(alice) <= before);
        eq(vault.balanceOf(address(engine)), engine.totalReservedShares());
    }

    function testFuzzVaultRounding(uint96 seed) public view {
        uint256 assets = bound(seed, 1, 1e15);
        uint256 shares = vault.previewDeposit(assets);
        ok(vault.previewRedeem(shares) <= assets);
        ok(vault.previewMint(shares) <= assets);
    }
}
