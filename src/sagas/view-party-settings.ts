import { LOCATION_CHANGED } from '@mraerino/redux-little-router-reactless';
import { buffers, eventChannel, Channel, END } from 'redux-saga';
import { call, put, select, take, takeLatest } from 'redux-saga/effects';

import { Types } from '../actions';
import {
    flushQueue,
    flushQueueFail,
    flushQueueFinish,
    insertPlaylist as insertFallbackPlaylist,
    insertPlaylistFail,
    insertPlaylistFinish,
    insertPlaylistProgress,
    loadPlaylists,
    loadPlaylistsFail,
    loadPlaylistsStart,
    updateUserPlaylists,
    ChangePartySettingAction,
    InsertFallbackPlaylistStartAction,
    UpdatePartyNameAction,
} from '../actions/view-party-settings';
import { PartyViews } from '../routing';
import { isPartyOwnerSelector } from '../selectors/party';
import { queueTracksSelector } from '../selectors/track';
import { hasConnectedSpotifyAccountSelector } from '../selectors/users';
import { PartySettings, Playlist, State, Track } from '../state';
import firebase from '../util/firebase';

function* changePartySetting(partyId: string, ac: ChangePartySettingAction<keyof PartySettings>) {
    if (!(yield select(isPartyOwnerSelector))) {
        return;
    }

    yield firebase.database!()
        .ref('/parties')
        .child(partyId)
        .child('settings')
        .child(ac.payload.setting)
        .set(ac.payload.value);
}

function* fetchPlaylists() {
    const state: State = yield select();
    if (!state.router.result ||
        state.router.result.subView !== PartyViews.Settings ||
        !hasConnectedSpotifyAccountSelector(state)) {
        return;
    }

    yield put(loadPlaylistsStart());
    try {
        const playlists: Playlist[] = yield call(loadPlaylists);
        yield put(updateUserPlaylists(playlists));
    } catch (err) {
        yield put(loadPlaylistsFail(err));
    }
}

function* flushTracks(partyId: string) {
    try {
        const tracks: Track[] = yield select(queueTracksSelector);
        if (tracks.length) {
            yield call(flushQueue, partyId, tracks);
        }
        yield put(flushQueueFinish());
    } catch (err) {
        yield put(flushQueueFail(err));
    }
}

function* insertPlaylist(partyId: string, ac: InsertFallbackPlaylistStartAction) {
    type SubActions =
        | { type: 'progress', payload: number }
        | { type: 'error', payload: Error }
        | END;

    function doInsert(creationDate: number) {
        return eventChannel<SubActions>(put => {
            insertFallbackPlaylist(
                partyId,
                creationDate,
                ac.payload.playlist,
                ac.payload.shuffled,
                progress => put({ type: 'progress', payload: progress }),
            )
                .then(() => put(END))
                .catch(err => put({ type: 'error', payload: err }));

            return () => {};
        }, buffers.expanding());
    }

    const createdOn: number = yield select((s: State) => s.party.currentParty!.created_at);
    const chan: Channel<SubActions> = yield call(doInsert, createdOn);

    while (true) {
        const ev: SubActions = yield take.maybe(chan);
        if (ev === END) {
            yield put(insertPlaylistFinish());
            break;
        } else if (ev.type === 'progress') {
            yield put(insertPlaylistProgress(ev.payload));
        } else if (ev.type === 'error') {
            yield put(insertPlaylistFail(ev.payload));
            break;
        }
    }
}

function* updatePartyName(partyId: string, ac: UpdatePartyNameAction) {
    yield firebase.database!()
        .ref('/parties')
        .child(partyId)
        .child('name')
        .set(ac.payload);
}

export function* managePartySettings(partyId: string) {
    yield takeLatest(Types.CHANGE_PARTY_SETTING, changePartySetting, partyId);
    yield takeLatest(Types.FLUSH_QUEUE_Start, flushTracks, partyId);
    yield takeLatest(Types.INSERT_FALLBACK_PLAYLIST_Start, insertPlaylist, partyId);
    yield takeLatest(Types.UPDATE_PARTY_NAME, updatePartyName, partyId);
}

export default function*() {
    yield takeLatest([
        Types.NOTIFY_AUTH_STATUS_KNOWN,
        LOCATION_CHANGED,
    ], fetchPlaylists);
}
