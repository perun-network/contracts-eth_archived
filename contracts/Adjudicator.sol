// Copyright 2019 - See NOTICE file for copyright holders.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;

import "./Channel.sol";
import "./App.sol";
import "./AssetHolder.sol";
import "./Sig.sol";
import "../vendor/SafeMath.sol";

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
    enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

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
        require(state.channelID == channelID, "invalid channelID");
        require(disputes[channelID].stateHash == bytes32(0), "state already registered");
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
        require(state.channelID == channelID, "invalid channelID");
        require(state.version > disputes[channelID].version , "can only refute with newer state");
        // solhint-disable-next-line not-rely-on-time
        require(disputes[channelID].timeout > now, "timeout passed");
        require(disputes[channelID].disputePhase == uint8(DisputePhase.DISPUTE),
                "channel must be in DISPUTE phase");
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
        if(disputes[channelID].disputePhase == uint8(DisputePhase.DISPUTE)) {
            // solhint-disable-next-line not-rely-on-time
            require(disputes[channelID].timeout <= now, "timeout not passed yet");
        } else {
            require(disputes[channelID].disputePhase == uint8(DisputePhase.FORCEEXEC),
                    "channel must be in FORCEEXEC phase");
        }
        require(state.channelID == channelID, "invalid channelID");
        require(disputes[channelID].stateHash == keccak256(abi.encode(stateOld)), "wrong old state");
        require(Sig.verify(Channel.encodeState(state), sig, params.participants[actorIdx]),
            "actorIdx does not match signer's index");
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
        // solhint-disable-next-line not-rely-on-time
        require(disputes[channelID].timeout <= now, "timeout not passed yet");
        require(disputes[channelID].stateHash == keccak256(abi.encode(state)), "wrong old state");

        _conclude(channelID, params, state);
    }

    /**
     * @notice ConcludeFinal can be used to immediately conclude a final state
     * without registering it or waiting for a timeout.
     * If the call was successful, a FinalConcluded and Concluded event is emitted.
     * Since any fully-signed final state supersedes any ongoing dispute,
     * concludeFinal may skip any registered dispute.
     *
     * @dev The caller has to provide n signatures on the final state.
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
        require(state.isFinal == true, "state not final");
        bytes32 channelID = calcChannelID(params);
        require(state.channelID == channelID, "invalid channelID");
        validateSignatures(params, state, sigs);

        _conclude(channelID, params, state);

        emit FinalConcluded(channelID);
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
        require(state.outcome.locked.length == 0, "not implemented yet");
        // solhint-disable-next-line not-rely-on-time
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
        require(to.version == from.version + 1, "version counter must increment by one");
        require(from.isFinal == false, "cannot progress from final state");
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
        require(oldAlloc.balances.length == newAlloc.balances.length,
                "balances length mismatch");
        require(oldAlloc.assets.length == newAlloc.assets.length,
                "assets length mismatch");
        for (uint256 i = 0; i < newAlloc.assets.length; i++) {
            require(oldAlloc.assets[i] == newAlloc.assets[i], "assets[i] address mismatch");
            uint256 sumOld = 0;
            uint256 sumNew = 0;
            require(oldAlloc.balances[i].length == numParts,
                    "oldAlloc: balances[i] length mismatch");
            require(newAlloc.balances[i].length == numParts,
                    "newAlloc: balances[i] length mismatch");
            for (uint256 k = 0; k < numParts; k++) {
                sumOld = sumOld.add(oldAlloc.balances[i][k]);
                sumNew = sumNew.add(newAlloc.balances[i][k]);
            }
            require(oldAlloc.locked.length == 0, "not implemented yet");
            require(newAlloc.locked.length == 0, "not implemented yet");
            require(sumOld == sumNew, "sum of balances mismatch");
        }
    }

    /**
     * @notice Concludes the channel by setting the outcome on all asset holder.
     * @dev Called by conclude and concludeFinal. Records the channel as
     * concluded so repeated conclude calls are not possible.
     * @param channelID The unique identifier of the channel.
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     */
    function _conclude(
        bytes32 channelID,
        Channel.Params memory params,
        Channel.State memory state)
    internal
    {
        require(disputes[channelID].disputePhase != uint8(DisputePhase.CONCLUDED),
            "channel already concluded");
        disputes[channelID].disputePhase = uint8(DisputePhase.CONCLUDED);
        pushOutcome(channelID, params, state);
        emit Concluded(channelID, state.version);
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
                "balances[i] length mismatch");
            // We set empty subAllocs because they are not implemented yet.
            a.setOutcome(channelID, params.participants, state.outcome.balances[i], subAllocs, balances[i]);
        }
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
        require(params.participants.length == sigs.length, "signatures length mismatch");
        for (uint256 i = 0; i < sigs.length; i++) {
            require(Sig.verify(encodedState, sigs[i], params.participants[i]), "invalid signature");
        }
    }
}
