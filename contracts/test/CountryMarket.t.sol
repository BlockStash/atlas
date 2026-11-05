// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {AtlasCountryMarket} from "../src/AtlasCountryMarket.sol";
import {AtlasCountryProxy} from "../src/AtlasCountryProxy.sol";
import {AtlasCountryTradingEngine} from "../src/AtlasCountryTradingEngine.sol";
import {AtlasUSDT} from "../src/AtlasUSDT.sol";
import {AtlasVault} from "../src/AtlasVault.sol";
import {IAtlasVault} from "../src/interfaces/IAtlasVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CountryMarketV2 is AtlasCountryMarket {
    function version() external pure override returns (uint256) {
        return 2;
    }

    function upgradedFeature() external pure returns (uint256) {
        return 42;
    }
}

contract CountryMarketTest is TestBase {
    AtlasCountryMarket implementation;
    AtlasCountryMarket market;
    AtlasCountryMarket india;
    AtlasCountryTradingEngine engine;
    AtlasUSDT token;
    AtlasVault vault;
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address delegate = address(0x1234);
    address treasury = address(0xfee);
    bytes32 constant ID = keccak256("AAPL");

    function setUp() public {
        vm.warp(1800000000);
        implementation = new AtlasCountryMarket();
        token = new AtlasUSDT(address(this));
        token.grantRole(token.MINTER_ROLE(), address(this));
        vault = new AtlasVault(IERC20(address(token)), address(this));
        address[] memory countries = new address[](5);
        for (uint256 i; i < 5; i++) {
            bytes3 currency;
            if (i == 1) currency = "INR";
            else currency = "USD";
            AtlasCountryMarket c = AtlasCountryMarket(
                address(
                    new AtlasCountryProxy(
                        address(implementation),
                        abi.encodeCall(AtlasCountryMarket.initialize, (address(this), bytes32(i + 1), currency))
                    )
                )
            );
            countries[i] = address(c);
            if (i == 0) market = c;
            if (i == 1) india = c;
            c.onboardStocks(inputs(ID, "AAPL"));
            c.setMarket(true, true, uint64(block.timestamp + 23 hours));
            publish(c, 270e8, i == 1 ? 1204819 : 1e8, 1e8);
        }
        engine = new AtlasCountryTradingEngine(address(this), IAtlasVault(address(vault)), countries, treasury);
        for (uint256 i; i < 5; i++) {
            AtlasCountryMarket(countries[i]).setTradingEngine(address(engine));
        }
        for (uint256 i; i < 2; i++) {
            address user = i == 0 ? alice : bob;
            token.mint(user, 100000e6);
            vm.startPrank(user);
            token.approve(address(vault), 100000e6);
            vault.deposit(100000e6, user);
            vault.approve(address(engine), type(uint256).max);
            vm.stopPrank();
        }
    }

    function inputs(bytes32 id, string memory ticker)
        private
        pure
        returns (AtlasCountryMarket.StockInput[] memory rows)
    {
        rows = new AtlasCountryMarket.StockInput[](1);
        rows[0] = AtlasCountryMarket.StockInput(id, ticker, "Demo stock", "US", "NASDAQ", keccak256(bytes(ticker)));
    }

    function publish(AtlasCountryMarket c, uint256 price, uint256 fx, uint256 usdt) private {
        vm.warp(block.timestamp + 1);
        AtlasCountryMarket.PriceInput[] memory p = new AtlasCountryMarket.PriceInput[](1);
        p[0] = AtlasCountryMarket.PriceInput(ID, price);
        c.publishPrices(p, fx, usdt, uint64(block.timestamp), uint64(block.timestamp + 900));
    }

    function buy() private {
        vm.prank(alice);
        engine.buy(address(market), ID, 2e18, type(uint256).max, block.timestamp + 100);
    }

    function testOneContractHoldsMultipleStocksAndBatchIsAtomic() public {
        market.onboardStocks(inputs(keccak256("MSFT"), "MSFT"));
        eq(market.stockCount(), 2);
        eq(india.stockCount(), 1);
        vm.expectRevert(AtlasCountryMarket.DuplicateStock.selector);
        market.onboardStocks(inputs(ID, "OTHER"));
        vm.expectRevert(AtlasCountryMarket.DuplicateStock.selector);
        market.onboardStocks(inputs(keccak256("DUP"), "AAPL"));
        eq(market.stockCount(), 2);
    }

    function testOwnerDelegatesOnlySelectedFunctions() public {
        market.grantRole(keccak256("STOCK_ADMIN_ROLE"), delegate);
        vm.prank(delegate);
        market.onboardStocks(inputs(keccak256("NEW"), "NEW"));
        eq(market.stockCount(), 2);
        vm.prank(delegate);
        vm.expectRevert();
        market.grantRole(keccak256("ADMIN_ROLE"), bob);
        vm.prank(delegate);
        vm.expectRevert();
        market.setMarket(true, true, uint64(block.timestamp + 100));
        market.revokeRole(keccak256("STOCK_ADMIN_ROLE"), delegate);
        vm.prank(delegate);
        vm.expectRevert();
        market.setStockActive(ID, false);
    }

    function testBroadAdminCannotUpgradeTransferOwnerOrGrantRoles() public {
        market.grantRole(keccak256("ADMIN_ROLE"), delegate);
        vm.prank(delegate);
        market.setStockActive(ID, false);
        CountryMarketV2 next = new CountryMarketV2();
        vm.prank(delegate);
        vm.expectRevert();
        market.upgradeToAndCall(address(next), "");
        vm.prank(delegate);
        vm.expectRevert();
        market.transferOwnership(delegate);
        vm.prank(delegate);
        vm.expectRevert();
        market.grantRole(keccak256("ADMIN_ROLE"), bob);
    }

    function testOwnershipTransferIsTwoStepAndOldOwnerLosesControl() public {
        market.transferOwnership(bob);
        ok(market.owner() == address(this));
        vm.prank(alice);
        vm.expectRevert();
        market.acceptOwnership();
        vm.prank(bob);
        market.acceptOwnership();
        ok(market.owner() == bob);
        vm.expectRevert();
        market.grantRole(keccak256("ADMIN_ROLE"), alice);
        vm.prank(bob);
        market.grantRole(keccak256("ADMIN_ROLE"), alice);
        ok(market.hasRole(keccak256("ADMIN_ROLE"), alice));
    }

    function testImplementationAndProxyCannotReinitialize() public {
        vm.expectRevert();
        implementation.initialize(alice, "usa", "USD");
        vm.expectRevert();
        market.initialize(alice, "usa", "USD");
    }

    function testOwnerOnlyUpgradePreservesStockBalanceRolesPricesAndEngine() public {
        buy();
        market.grantRole(keccak256("STOCK_ADMIN_ROLE"), delegate);
        CountryMarketV2 next = new CountryMarketV2();
        market.upgradeToAndCall(address(next), "");
        eq(market.version(), 2);
        eq(CountryMarketV2(address(market)).upgradedFeature(), 42);
        eq(market.balanceOf(alice, uint256(ID)), 2e18);
        eq(market.totalSupply(uint256(ID)), 2e18);
        ok(market.owner() == address(this));
        ok(market.tradingEngine() == address(engine));
        ok(market.hasRole(keccak256("STOCK_ADMIN_ROLE"), delegate));
        (uint256 price,,,) = market.getStockPriceUSDT(ID);
        eq(price, 270e8);
        eq(market.stockCount(), 1);
        vm.prank(alice);
        market.setApprovalForAll(address(engine), true);
        vm.prank(alice);
        engine.sell(address(market), ID, 1e18, 0, block.timestamp + 100);
    }

    function testDollarUsdtDepegAndNativeFxConversion() public {
        publish(market, 270e8, 1e8, 98e6);
        (uint256 price,,, uint256 usd) = market.getStockPriceUSDT(ID);
        eq(usd, 270e8);
        eq(price, uint256(270e8) * 1e8 / 98e6);
        publish(india, 2850e8, 1204819, 1e8);
        (price,,, usd) = india.getStockPriceUSDT(ID);
        eq(price, 3433734150);
        eq(usd, price);
    }

    function testStaleUsdtFxAndNativeSnapshotRejectsTrading() public {
        vm.warp(block.timestamp + 901);
        vm.expectRevert(AtlasCountryMarket.StalePrice.selector);
        engine.quoteBuy(address(market), ID, 1e18);
    }

    function testFeedChangeInvalidatesPrice() public {
        market.updateStock(ID, "New source", keccak256("feed2"));
        vm.expectRevert(AtlasCountryMarket.StalePrice.selector);
        market.getStockPriceUSDT(ID);
    }

    function testFreshFxCannotReviveAnUnrefreshedStock() public {
        bytes32 second = keccak256("SECOND");
        market.onboardStocks(inputs(second, "SECOND"));
        vm.warp(block.timestamp + 901);
        AtlasCountryMarket.PriceInput[] memory p = new AtlasCountryMarket.PriceInput[](1);
        p[0] = AtlasCountryMarket.PriceInput(second, 100e8);
        market.publishPrices(p, 1e8, 1e8, uint64(block.timestamp), uint64(block.timestamp + 900));
        vm.expectRevert(AtlasCountryMarket.StalePrice.selector);
        market.getStockPriceUSDT(ID);
        (uint256 price,,,) = market.getStockPriceUSDT(second);
        eq(price, 100e8);
    }

    function testOnlyEngineCanMintAndBurnNeedsApproval() public {
        vm.expectRevert();
        market.mintStock(alice, ID, 1e18);
        buy();
        vm.prank(alice);
        vm.expectRevert(AtlasCountryMarket.ApprovalRequired.selector);
        engine.sell(address(market), ID, 1e18, 0, block.timestamp + 100);
        vm.prank(alice);
        market.setApprovalForAll(address(engine), true);
        vm.prank(alice);
        engine.sell(address(market), ID, 1e18, 0, block.timestamp + 100);
        eq(market.balanceOf(alice, uint256(ID)), 1e18);
    }

    function testProfitRequiresAssetSpecificReserveAndDoesNotBurnOnFailure() public {
        buy();
        publish(market, 400e8, 1e8, 1e8);
        vm.prank(alice);
        market.setApprovalForAll(address(engine), true);
        vm.prank(alice);
        vm.expectRevert(AtlasCountryTradingEngine.InsufficientLiquidity.selector);
        engine.sell(address(market), ID, 2e18, 0, block.timestamp + 100);
        eq(market.balanceOf(alice, uint256(ID)), 2e18);
        vm.prank(bob);
        engine.fundReserve(address(market), ID, 300e12);
        vm.prank(alice);
        engine.sell(address(market), ID, 2e18, 0, block.timestamp + 100);
        eq(market.balanceOf(alice, uint256(ID)), 0);
        eq(engine.reservedShares(address(india), ID), 0);
    }

    function testDisabledPausedClosedAndUnsupportedMarketsReject() public {
        market.setStockActive(ID, false);
        vm.expectRevert();
        engine.quoteBuy(address(market), ID, 1e18);
        market.setStockActive(ID, true);
        market.pause();
        vm.expectRevert();
        engine.quoteBuy(address(market), ID, 1e18);
        market.unpause();
        market.setMarket(true, false, uint64(block.timestamp + 100));
        vm.expectRevert();
        engine.quoteBuy(address(market), ID, 1e18);
        vm.expectRevert();
        engine.quoteBuy(address(implementation), ID, 1e18);
    }

    function testSnapshotRejectsFutureDuplicateZeroAndRollback() public {
        AtlasCountryMarket.PriceInput[] memory p = new AtlasCountryMarket.PriceInput[](1);
        p[0] = AtlasCountryMarket.PriceInput(ID, 270e8);
        vm.expectRevert();
        market.publishPrices(p, 1e8, 1e8, uint64(block.timestamp + 100), uint64(block.timestamp + 200));
        vm.expectRevert();
        market.publishPrices(p, 1e8, 0, uint64(block.timestamp), uint64(block.timestamp + 100));
        vm.expectRevert();
        market.publishPrices(p, 1e8, 1e8, 1, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 1);
        p[0].nativePrice = 0;
        vm.expectRevert();
        market.publishPrices(p, 1e8, 1e8, uint64(block.timestamp), uint64(block.timestamp + 100));
    }

    function testFuzzCountryRoundTripNeverCreatesVaultShares(uint96 amount) public {
        uint256 quantity = bound(amount, 1e12, 50e18);
        uint256 beforeBalance = vault.balanceOf(alice);
        vm.prank(alice);
        engine.buy(address(market), ID, quantity, type(uint256).max, block.timestamp + 100);
        vm.prank(alice);
        market.setApprovalForAll(address(engine), true);
        vm.prank(alice);
        engine.sell(address(market), ID, quantity, 0, block.timestamp + 100);
        ok(vault.balanceOf(alice) <= beforeBalance);
        eq(market.totalSupply(uint256(ID)), 0);
        eq(vault.balanceOf(address(engine)), engine.totalReservedShares());
    }
}
