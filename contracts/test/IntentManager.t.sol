// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {AtlasIntentManager} from "../src/AtlasIntentManager.sol";

interface VmSign {
    function sign(uint256 pk, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 pk) external returns (address);
    function expectRevert(bytes calldata) external;
}

contract IntentManagerTest is TestBase {
    VmSign internal constant vs = VmSign(address(uint160(uint256(keccak256("hevm cheat code")))));
    AtlasIntentManager internal m;
    address internal admin = address(0xA11CE);
    address internal executor = address(0xE0E0);
    uint256 internal constant PK = 0xBEEF;
    address internal user;

    function setUp() public {
        vm.warp(1_000_000);
        user = vs.addr(PK);
        m = new AtlasIntentManager(admin);
        vm.startPrank(admin);
        m.grantRole(m.EXECUTOR_ROLE(), executor);
        vm.stopPrank();
    }

    function _auth(bytes32 id, uint256 nonce)
        internal
        view
        returns (AtlasIntentManager.AtlasIntentAuthorization memory)
    {
        return AtlasIntentManager.AtlasIntentAuthorization({
            user: user,
            intentId: id,
            stockId: keccak256("AAPL"),
            maxSpendUSDT: 1_000e6,
            maxSlippageBps: 50,
            takeProfitBps: 800,
            stopLossBps: 300,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1 days,
            nonce: nonce,
            strategyHash: keccak256("strategy")
        });
    }

    function _sig(AtlasIntentManager.AtlasIntentAuthorization memory a) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vs.sign(PK, m.hashAuthorization(a));
        return abi.encodePacked(r, s, v);
    }

    function _activate(bytes32 id, uint256 nonce)
        internal
        returns (AtlasIntentManager.AtlasIntentAuthorization memory a)
    {
        a = _auth(id, nonce);
        m.activateIntent(a, _sig(a));
    }

    function test_activate() public {
        _activate(bytes32(uint256(1)), 1);
        ok(m.isActive(bytes32(uint256(1))));
        ok(m.nonceUsed(user, 1));
    }

    function test_replayRejected() public {
        AtlasIntentManager.AtlasIntentAuthorization memory a = _activate(bytes32(uint256(1)), 1);
        bytes memory sig = _sig(a);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.IntentExists.selector));
        m.activateIntent(a, sig);
        // Same nonce, different intent id.
        AtlasIntentManager.AtlasIntentAuthorization memory b = _auth(bytes32(uint256(2)), 1);
        bytes memory sigB = _sig(b);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.NonceAlreadyUsed.selector));
        m.activateIntent(b, sigB);
    }

    function test_badSignatureAndTamper() public {
        AtlasIntentManager.AtlasIntentAuthorization memory a = _auth(bytes32(uint256(1)), 1);
        bytes memory sig = _sig(a);
        a.maxSpendUSDT = 2_000e6; // tampered after signing
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.InvalidSignature.selector));
        m.activateIntent(a, sig);
    }

    function test_windowEnforced() public {
        AtlasIntentManager.AtlasIntentAuthorization memory a = _auth(bytes32(uint256(1)), 1);
        a.validAfter = block.timestamp + 100;
        a.validUntil = block.timestamp + 200;
        bytes memory sig = _sig(a);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.NotYetValid.selector));
        m.activateIntent(a, sig);
        vm.warp(block.timestamp + 300);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.IntentExpired.selector));
        m.activateIntent(a, sig);
    }

    function test_invalidateNonceBlocksActivation() public {
        AtlasIntentManager.AtlasIntentAuthorization memory a = _auth(bytes32(uint256(1)), 9);
        bytes memory sig = _sig(a);
        vm.prank(user);
        m.invalidateNonce(9);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.NonceAlreadyUsed.selector));
        m.activateIntent(a, sig);
    }

    function test_cancelOnlyOwner() public {
        _activate(bytes32(uint256(1)), 1);
        vs.expectRevert(abi.encodeWithSelector(AtlasIntentManager.NotIntentOwner.selector));
        m.cancelIntent(bytes32(uint256(1)));
        vm.prank(user);
        m.cancelIntent(bytes32(uint256(1)));
        ok(!m.isActive(bytes32(uint256(1))));
    }

    function test_executeCompleteLifecycle() public {
        bytes32 id = bytes32(uint256(1));
        _activate(id, 1);
        vm.expectRevert();
        m.markExecuted(id); // not executor
        vm.prank(executor);
        m.markExecuted(id);
        // Executed intents cannot be cancelled or executed twice.
        vm.prank(user);
        vm.expectRevert();
        m.cancelIntent(id);
        vm.prank(executor);
        vm.expectRevert();
        m.markExecuted(id);
        vm.prank(executor);
        m.markCompleted(id);
        eq(uint256(m.getIntent(id).status), uint256(AtlasIntentManager.IntentStatus.COMPLETED));
    }

    function test_expire() public {
        bytes32 id = bytes32(uint256(1));
        _activate(id, 1);
        vm.expectRevert();
        m.expireIntent(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(executor);
        vm.expectRevert();
        m.markExecuted(id);
        m.expireIntent(id);
        eq(uint256(m.getIntent(id).status), uint256(AtlasIntentManager.IntentStatus.EXPIRED));
    }
}
