// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;

import "./Channel.sol";
import "./App.sol";
import "./AssetHolder.sol";
import "./SafeMath.sol";
import "./Sig.sol";

/**
 * @title The Perun Adjudicator
 * @author The Perun Authors
 * @dev Adjudicator is the contract that decides on the current state of a statechannel.
 */
contract Adjudicator {

    using SafeMath for uint256;

    /**
     * @dev Our state machine has two phases.
     * In the DISPUTE phase, all parties have the ability to publish their latest state.
     * In the FORCEEXEC phase, the smart contract is executed on-chain.
     */
    enum DisputePhase { DISPUTE, FORCEEXEC }

    struct Dispute {
        uint64 timeout;
        uint64 version;
        uint8 disputePhase;
        bytes32 stateHash;
    }

    /**
     * @dev Mapping channelID => Dispute.
     */
    mapping(bytes32 => Dispute) public disputes;

    event Registered(bytes32 indexed channelID, uint64 version);
    event Refuted(bytes32 indexed channelID, uint64 version);
    event Progressed(bytes32 indexed channelID, uint64 version);
    event Stored(bytes32 indexed channelID, uint64 version, uint64 timeout);
    event FinalConcluded(bytes32 indexed channelID);
    event Concluded(bytes32 indexed channelID, uint64 version);
    event OutcomePushed(bytes32 indexed channelID, uint64 version);

    /**
     * @notice Register registers a non-final state of a channel.
     * If the call was successful a Registered event is emitted.
     *
     * @dev It can only be called if no other dispute is currently in progress.
     * The caller has to provide n signatures on the state.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function register(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID].stateHash == bytes32(0), "a dispute was already registered");
        validateSignatures(params, state, sigs);
        storeChallenge(params, state, channelID, DisputePhase.DISPUTE);
        emit Registered(channelID, state.version);
    }

    /**
     * @notice Refute is called to refute a dispute.
     * If the call was successful a Refuted event is emitted.
     *
     * @dev Refute can only be called with a higher version state.
     * The caller has to provide n signatures on the new state.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function refute(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried refutation with invalid channelID");
        require(state.version > disputes[channelID].version , "only a refutation with a newer state is valid");
        require(disputes[channelID].timeout > now, "tried refutation after timeout");
        require(disputes[channelID].disputePhase == uint8(DisputePhase.DISPUTE), "channel is not in state DISPUTE");
        validateSignatures(params, state, sigs);
        storeChallenge(params, state, channelID, DisputePhase.DISPUTE);
        emit Refuted(channelID, state.version);
    }

    /**
     * @notice Progress is used to advance the state of an app on-chain.
     * If the call was successful, a Progressed event is emitted.
     *
     * @dev The caller has to provide a valid signature from the actor.
     * It is checked whether the new state is a valid transition from the old state,
     * so this method can only advance the state by one step.
     *
     * @param params The parameters of the state channel.
     * @param stateOld The previously stored state of the state channel.
     * @param state The new state to which we want to progress.
     * @param actorIdx Index of the signer in the participants array.
     * @param sig Signature of the participant that wants to progress the contract on the new state.
     */
    function progress(
        Channel.Params memory params,
        Channel.State memory stateOld,
        Channel.State memory state,
        uint256 actorIdx,
        bytes memory sig)
    public
    {
        require(actorIdx < params.participants.length, "actorIdx out of range");
        bytes32 channelID = calcChannelID(params);
        if(disputes[channelID].disputePhase == uint8(uint256(DisputePhase.DISPUTE))) {
            require(now >= disputes[channelID].timeout, "function called before timeout");
        }
        require(state.channelID == channelID, "tried progressing with invalid channelID");
        require(disputes[channelID].stateHash == keccak256(abi.encode(stateOld)), "provided wrong old state");
        require(Sig.verify(Channel.encodeState(state), sig, params.participants[actorIdx]),
            "actorIdx is not set to the index of the sender");
        requireValidTransition(params, stateOld, state, actorIdx);
        storeChallenge(params, state, channelID, DisputePhase.FORCEEXEC);
        emit Progressed(channelID, state.version);
    }
    /**
     * @notice Conclude is used to finalize a channel on-chain.
     * It can only be called after the timeout is over.
     * If the call was successful, a Concluded event is emitted.
     *
     * @param params The parameters of the state channel.
     * @param state The previously stored state of the state channel.
     */
    function conclude(
        Channel.Params memory params,
        Channel.State memory state)
    public
    {
        bytes32 channelID = calcChannelID(params);
        require(disputes[channelID].timeout < now, "tried conclude before timeout");
        require(disputes[channelID].stateHash == keccak256(abi.encode(state)), "provided wrong old state");
        pushOutcome(channelID, params, state);
        emit Concluded(channelID, state.version);
    }

    /**
     * @notice ConcludeFinal can be used to immediately conclude a final state
     * without registering it or waiting for a timeout.
     * If the call was successful, a FinalConcluded and Concluded event is emitted.
     *
     * @dev The caller has to provide n signatures on the final state.
     * It can only be called if no other dispute for this channel was registered.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function concludeFinal(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    public
    {
        require(state.isFinal == true, "only accept final states");
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "tried registering invalid channelID");
        require(disputes[channelID].stateHash == bytes32(0), "a dispute was already registered");
        validateSignatures(params, state, sigs);
        pushOutcome(channelID, params, state);
        emit FinalConcluded(channelID);
        emit Concluded(channelID, state.version);
    }

    /**
     * @notice Calculates the channelID of the state channel.
     * @param params The parameter of the channel.
     * @return The channelID
     */
    function calcChannelID(Channel.Params memory params) internal pure returns (bytes32) {
        return keccak256(abi.encode(params.challengeDuration, params.nonce, params.app, params.participants));
    }

    /**
     * @dev Stores the provided challenge in the dipute registry
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param channelID The channelID of the state channel.
     * @param disputePhase The phase in which the state channel is currently.
     */
    function storeChallenge(
        Channel.Params memory params,
        Channel.State memory state,
        bytes32 channelID,
        DisputePhase disputePhase)
    internal
    {
        // We require empty subAllocs because they are not implemented yet.
        require(state.outcome.locked.length == 0);
        uint256 timeout = now.add(params.challengeDuration);
        disputes[channelID].stateHash = keccak256(abi.encode(state));
        disputes[channelID].timeout = uint64(timeout);
        disputes[channelID].disputePhase = uint8(disputePhase);
        disputes[channelID].version = state.version;
        emit Stored(channelID, state.version, uint64(timeout));
    }

    /**
     * @dev Checks if a transition between two states is valid.
     * This calls the validTransition() function of the app.
     *
     * @param params The parameters of the state channel.
     * @param from The previous state of the state channel.
     * @param to The new state of the state channel.
     * @param actorIdx Index of the signer in the participants array.
     */
    function requireValidTransition(
        Channel.Params memory params,
        Channel.State memory from,
        Channel.State memory to,
        uint256 actorIdx)
    internal pure
    {
        require(to.version == from.version + 1, "can only advance the version counter by one");
        require(from.isFinal == false, "cannot advance from final state");
        requireAssetPreservation(from.outcome, to.outcome, params.participants.length);
        App app = App(params.app);
        app.validTransition(params, from, to, actorIdx);
    }

    /**
     * @dev Checks if two allocations are compatible, e.g. if the sums of the allocations are equal.
     * @param oldAlloc The old allocation.
     * @param newAlloc The new allocation.
     * @param numParts length of the participants in the parameters.
     */
    function requireAssetPreservation(
        Channel.Allocation memory oldAlloc,
        Channel.Allocation memory newAlloc,
        uint256 numParts)
    internal pure
    {
        require(oldAlloc.balances.length == newAlloc.balances.length, "length of balances do not match");
        require(oldAlloc.assets.length == newAlloc.assets.length, "length of assets do not match");
        for (uint256 i = 0; i < newAlloc.assets.length; i++) {
            require(oldAlloc.assets[i] == newAlloc.assets[i], 'asset addresses mismatch');
            uint256 sumOld = 0;
            uint256 sumNew = 0;
            require(oldAlloc.balances[i].length == numParts, "length of balances[i] of oldAlloc does not match numParts");
            require(newAlloc.balances[i].length == numParts, "length of balances[i] do newAlloc does not match numParts");
            for (uint256 k = 0; k < numParts; k++) {
                sumOld = sumOld.add(oldAlloc.balances[i][k]);
                sumNew = sumNew.add(newAlloc.balances[i][k]);
            }
            require(oldAlloc.locked.length == 0, "subAllocs currently not implemented");
            require(newAlloc.locked.length == 0, "subAllocs currently not implemented");
            require(sumOld == sumNew, 'Sum of balances for an asset must be equal');
        }
    }

    /**
     * @notice Sets the outcome on all assetholder contracts.
     * @param channelID The unique identifier of the channel.
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     */
    function pushOutcome(
        bytes32 channelID,
        Channel.Params memory params,
        Channel.State memory state)
    internal
    {
        uint256[][] memory balances = new uint256[][](state.outcome.assets.length);
        bytes32[] memory subAllocs = new bytes32[](state.outcome.locked.length);
        for (uint256 i = 0; i < state.outcome.assets.length; i++) {
            AssetHolder a = AssetHolder(state.outcome.assets[i]);
            require(state.outcome.balances[i].length == params.participants.length,
                "balances length should match participants length");
            // We set empty subAllocs because they are not implemented yet.
            a.setOutcome(channelID, params.participants, state.outcome.balances[i], subAllocs, balances[i]);
        }
        emit OutcomePushed(channelID, state.version);
    }

    /**
     * @dev checks that we have n valid signatures on a state.
     * @param params The parameters corresponding to the state.
     * @param state The state of the state channel.
     * @param sigs An array of n signatures corresponding to the n participants of the channel.
     */
    function validateSignatures(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    internal pure
    {
        bytes memory encodedState = Channel.encodeState(state);
        require(params.participants.length == sigs.length, "invalid length of signatures");
        for (uint256 i = 0; i < sigs.length; i++) {
            require(Sig.verify(encodedState, sigs[i], params.participants[i]), "invalid signature");
        }
    }
}
