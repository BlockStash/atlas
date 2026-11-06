// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Registry of user-signed trading-intent authorizations.
/// @dev Holds no funds and contains no AI logic. It only proves that a user signed a normalized strategy
/// (via `strategyHash`), enforces the validity window, prevents replay, and records lifecycle state.
/// Trade execution is a separate concern: an execution engine must check `isActive` before acting.
contract AtlasIntentManager is EIP712, AccessControl, Pausable {
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum IntentStatus {
        NONE,
        ACTIVE,
        EXECUTED,
        COMPLETED,
        CANCELLED,
        EXPIRED
    }

    struct AtlasIntentAuthorization {
        address user;
        bytes32 intentId;
        bytes32 stockId;
        uint256 maxSpendUSDT;
        uint256 maxSlippageBps;
        uint256 takeProfitBps;
        uint256 stopLossBps;
        uint256 validAfter;
        uint256 validUntil;
        uint256 nonce;
        bytes32 strategyHash;
    }

    struct IntentRecord {
        address user;
        IntentStatus status;
        uint64 validUntil;
        bytes32 stockId;
        bytes32 strategyHash;
        uint256 maxSpendUSDT;
    }

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "AtlasIntentAuthorization(address user,bytes32 intentId,bytes32 stockId,uint256 maxSpendUSDT,uint256 maxSlippageBps,uint256 takeProfitBps,uint256 stopLossBps,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 strategyHash)"
    );
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_VALIDITY = 365 days;

    mapping(bytes32 => IntentRecord) private _intents;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    error InvalidAuthorization();
    error NotYetValid();
    error IntentExpired();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error IntentExists();
    error WrongStatus(IntentStatus current);
    error NotIntentOwner();
    error NotExpired();

    event IntentActivated(
        bytes32 indexed intentId, address indexed user, bytes32 indexed stockId, bytes32 strategyHash, uint256 nonce
    );
    event IntentCancelled(bytes32 indexed intentId, address indexed user);
    event IntentExecuted(bytes32 indexed intentId);
    event IntentCompleted(bytes32 indexed intentId);
    event IntentExpiredEvent(bytes32 indexed intentId);
    event NonceInvalidated(address indexed user, uint256 nonce);

    constructor(address admin) EIP712("AtlasIntentManager", "1") {
        if (admin == address(0)) revert InvalidAuthorization();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function hashAuthorization(AtlasIntentAuthorization calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    AUTHORIZATION_TYPEHASH,
                    a.user,
                    a.intentId,
                    a.stockId,
                    a.maxSpendUSDT,
                    a.maxSlippageBps,
                    a.takeProfitBps,
                    a.stopLossBps,
                    a.validAfter,
                    a.validUntil,
                    a.nonce,
                    a.strategyHash
                )
            )
        );
    }

    /// @notice Anyone (user or relayer) may submit a user's signed authorization.
    function activateIntent(AtlasIntentAuthorization calldata a, bytes calldata signature) external whenNotPaused {
        if (
            a.user == address(0) || a.intentId == bytes32(0) || a.stockId == bytes32(0) || a.strategyHash == bytes32(0)
                || a.maxSpendUSDT == 0 || a.maxSlippageBps > BPS || a.takeProfitBps > 1_000_000 || a.stopLossBps >= BPS
                || a.validUntil <= a.validAfter || a.validUntil - a.validAfter > MAX_VALIDITY
        ) revert InvalidAuthorization();
        if (block.timestamp < a.validAfter) revert NotYetValid();
        if (block.timestamp > a.validUntil) revert IntentExpired();
        if (_intents[a.intentId].status != IntentStatus.NONE) revert IntentExists();
        if (nonceUsed[a.user][a.nonce]) revert NonceAlreadyUsed();
        if (!SignatureChecker.isValidSignatureNow(a.user, hashAuthorization(a), signature)) revert InvalidSignature();

        nonceUsed[a.user][a.nonce] = true;
        _intents[a.intentId] = IntentRecord({
            user: a.user,
            status: IntentStatus.ACTIVE,
            validUntil: uint64(a.validUntil),
            stockId: a.stockId,
            strategyHash: a.strategyHash,
            maxSpendUSDT: a.maxSpendUSDT
        });
        emit IntentActivated(a.intentId, a.user, a.stockId, a.strategyHash, a.nonce);
    }

    /// @notice The owner cancels an ACTIVE intent. Executed intents need a separate position-close operation.
    function cancelIntent(bytes32 intentId) external {
        IntentRecord storage r = _intents[intentId];
        if (r.user != msg.sender) revert NotIntentOwner();
        if (r.status != IntentStatus.ACTIVE) revert WrongStatus(r.status);
        r.status = IntentStatus.CANCELLED;
        emit IntentCancelled(intentId, msg.sender);
    }

    /// @notice Burn a nonce so an unactivated signed authorization can never be submitted.
    function invalidateNonce(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    function markExecuted(bytes32 intentId) external onlyRole(EXECUTOR_ROLE) whenNotPaused {
        IntentRecord storage r = _intents[intentId];
        if (r.status != IntentStatus.ACTIVE) revert WrongStatus(r.status);
        if (block.timestamp > r.validUntil) revert IntentExpired();
        r.status = IntentStatus.EXECUTED;
        emit IntentExecuted(intentId);
    }

    function markCompleted(bytes32 intentId) external onlyRole(EXECUTOR_ROLE) {
        IntentRecord storage r = _intents[intentId];
        if (r.status != IntentStatus.EXECUTED) revert WrongStatus(r.status);
        r.status = IntentStatus.COMPLETED;
        emit IntentCompleted(intentId);
    }

    /// @notice Anyone may mark an unexecuted intent expired once its window has passed.
    function expireIntent(bytes32 intentId) external {
        IntentRecord storage r = _intents[intentId];
        if (r.status != IntentStatus.ACTIVE) revert WrongStatus(r.status);
        if (block.timestamp <= r.validUntil) revert NotExpired();
        r.status = IntentStatus.EXPIRED;
        emit IntentExpiredEvent(intentId);
    }

    function getIntent(bytes32 intentId) external view returns (IntentRecord memory) {
        return _intents[intentId];
    }

    function isActive(bytes32 intentId) external view returns (bool) {
        IntentRecord storage r = _intents[intentId];
        return r.status == IntentStatus.ACTIVE && block.timestamp <= r.validUntil;
    }
}
