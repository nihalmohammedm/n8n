import {
	changePassword,
	deleteUser,
	getPasswordResetLink,
	getUsers,
	login,
	loginCurrentUser,
	logout,
	sendForgotPasswordEmail,
	setupOwner,
	submitPersonalizationSurvey,
	updateCurrentUser,
	updateCurrentUserPassword,
	updateCurrentUserSettings,
	updateOtherUserSettings,
	validatePasswordToken,
	validateSignupToken,
} from '@/api/users';
import { PERSONALIZATION_MODAL_KEY, STORES } from '@/constants';
import type {
	Cloud,
	ICredentialsResponse,
	IInviteResponse,
	IPersonalizationLatestVersion,
	IRole,
	IUser,
	IUserResponse,
	IUsersState,
} from '@/Interface';
import { getCredentialPermissions } from '@/permissions';
import { getPersonalizedNodeTypes, isAuthorized, PERMISSIONS, ROLE } from '@/utils';
import { defineStore } from 'pinia';
import { useRootStore } from './n8nRoot.store';
import { usePostHog } from './posthog.store';
import { useSettingsStore } from './settings.store';
import { useUIStore } from './ui.store';
import { useCloudPlanStore } from './cloudPlan.store';
import { disableMfa, enableMfa, getMfaQR, verifyMfaToken } from '@/api/mfa';
import { confirmEmail, getCloudUserInfo } from '@/api/cloudPlans';
import { inviteUsers, acceptInvitation } from '@/api/invitation';

const isDefaultUser = (user: IUserResponse | null) =>
	Boolean(user && user.isPending && user.globalRole && user.globalRole.name === ROLE.Owner);

const isPendingUser = (user: IUserResponse | null) => Boolean(user && user.isPending);

const isInstanceOwner = (user: IUserResponse | null) =>
	Boolean(user?.globalRole?.name === ROLE.Owner);

export const useUsersStore = defineStore(STORES.USERS, {
	state: (): IUsersState => ({
		initialized: false,
		currentUserId: null,
		users: {},
		currentUserCloudInfo: null,
	}),
	getters: {
		allUsers(): IUser[] {
			return Object.values(this.users);
		},
		userActivated(): boolean {
			return Boolean(this.currentUser?.settings?.userActivated);
		},
		currentUser(): IUser | null {
			return this.currentUserId ? this.users[this.currentUserId] : null;
		},
		isDefaultUser(): boolean {
			return isDefaultUser(this.currentUser);
		},
		isInstanceOwner(): boolean {
			return isInstanceOwner(this.currentUser);
		},
		mfaEnabled(): boolean {
			return this.currentUser?.mfaEnabled ?? false;
		},
		getUserById(state) {
			return (userId: string): IUser | null => state.users[userId];
		},
		globalRoleName(): IRole {
			return this.currentUser?.globalRole?.name ?? 'default';
		},
		canUserDeleteTags(): boolean {
			return isAuthorized(PERMISSIONS.TAGS.CAN_DELETE_TAGS, this.currentUser);
		},
		canUserActivateLicense(): boolean {
			return isAuthorized(PERMISSIONS.USAGE.CAN_ACTIVATE_LICENSE, this.currentUser);
		},
		canUserAccessSidebarUserInfo() {
			if (this.currentUser) {
				const currentUser: IUser = this.currentUser;
				return isAuthorized(PERMISSIONS.PRIMARY_MENU.CAN_ACCESS_USER_INFO, currentUser);
			}
			return false;
		},
		showUMSetupWarning() {
			if (this.currentUser) {
				const currentUser: IUser = this.currentUser;
				return isAuthorized(PERMISSIONS.USER_SETTINGS.VIEW_UM_SETUP_WARNING, currentUser);
			}
			return false;
		},
		personalizedNodeTypes(): string[] {
			const user = this.currentUser;
			if (!user) {
				return [];
			}

			const answers = user.personalizationAnswers;
			if (!answers) {
				return [];
			}
			return getPersonalizedNodeTypes(answers);
		},
		isResourceAccessible() {
			return (resource: ICredentialsResponse): boolean => {
				const permissions = getCredentialPermissions(this.currentUser, resource);

				return permissions.use;
			};
		},
	},
	actions: {
		async initialize() {
			if (this.initialized) {
				return;
			}

			try {
				await this.loginWithCookie();
				this.initialized = true;
			} catch (e) {}
		},
		addUsers(users: IUserResponse[]) {
			users.forEach((userResponse: IUserResponse) => {
				const prevUser = this.users[userResponse.id] || {};
				const updatedUser = {
					...prevUser,
					...userResponse,
				};
				const user: IUser = {
					...updatedUser,
					fullName: userResponse.firstName
						? `${updatedUser.firstName} ${updatedUser.lastName || ''}`
						: undefined,
					isDefaultUser: isDefaultUser(updatedUser),
					isPendingUser: isPendingUser(updatedUser),
					isOwner: updatedUser.globalRole?.name === ROLE.Owner,
				};

				this.users = {
					...this.users,
					[user.id]: user,
				};
			});
		},
		deleteUserById(userId: string): void {
			const { [userId]: _, ...users } = this.users;
			this.users = users;
		},
		setPersonalizationAnswers(answers: IPersonalizationLatestVersion): void {
			if (!this.currentUser) {
				return;
			}

			this.users = {
				...this.users,
				[this.currentUser.id]: {
					...this.currentUser,
					personalizationAnswers: answers,
				},
			};
		},
		async loginWithCookie(): Promise<void> {
			const rootStore = useRootStore();
			const user = await loginCurrentUser(rootStore.getRestApiContext);
			if (!user) {
				return;
			}

			this.addUsers([user]);
			this.currentUserId = user.id;

			usePostHog().init(user.featureFlags);
		},
		async loginWithCreds(params: {
			email: string;
			password: string;
			mfaToken?: string;
			mfaRecoveryCode?: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			const user = await login(rootStore.getRestApiContext, params);
			if (!user) {
				return;
			}

			this.addUsers([user]);
			this.currentUserId = user.id;

			usePostHog().init(user.featureFlags);
		},
		async logout(): Promise<void> {
			const rootStore = useRootStore();
			await logout(rootStore.getRestApiContext);
			this.currentUserId = null;
			useCloudPlanStore().reset();
			usePostHog().reset();
			this.currentUserCloudInfo = null;
			useUIStore().clearBannerStack();
		},
		async createOwner(params: {
			firstName: string;
			lastName: string;
			email: string;
			password: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			const user = await setupOwner(rootStore.getRestApiContext, params);
			const settingsStore = useSettingsStore();
			if (user) {
				this.addUsers([user]);
				this.currentUserId = user.id;
				settingsStore.stopShowingSetupPage();
				usePostHog().init(user.featureFlags);
			}
		},
		async validateSignupToken(params: {
			inviteeId: string;
			inviterId: string;
		}): Promise<{ inviter: { firstName: string; lastName: string } }> {
			const rootStore = useRootStore();
			return validateSignupToken(rootStore.getRestApiContext, params);
		},
		async acceptInvitation(params: {
			inviteeId: string;
			inviterId: string;
			firstName: string;
			lastName: string;
			password: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			const user = await acceptInvitation(rootStore.getRestApiContext, params);
			if (user) {
				this.addUsers([user]);
				this.currentUserId = user.id;
				usePostHog().init(user.featureFlags);
			}
		},
		async sendForgotPasswordEmail(params: { email: string }): Promise<void> {
			const rootStore = useRootStore();
			await sendForgotPasswordEmail(rootStore.getRestApiContext, params);
		},
		async validatePasswordToken(params: { token: string }): Promise<void> {
			const rootStore = useRootStore();
			await validatePasswordToken(rootStore.getRestApiContext, params);
		},
		async changePassword(params: {
			token: string;
			password: string;
			mfaToken?: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			await changePassword(rootStore.getRestApiContext, params);
		},
		async updateUser(params: {
			id: string;
			firstName: string;
			lastName: string;
			email: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			const user = await updateCurrentUser(rootStore.getRestApiContext, params);
			this.addUsers([user]);
		},
		async updateUserSettings(settings: IUserResponse['settings']): Promise<void> {
			const rootStore = useRootStore();
			const updatedSettings = await updateCurrentUserSettings(
				rootStore.getRestApiContext,
				settings,
			);
			if (this.currentUser) {
				this.currentUser.settings = updatedSettings;
				this.addUsers([this.currentUser]);
			}
		},
		async updateOtherUserSettings(
			userId: string,
			settings: IUserResponse['settings'],
		): Promise<void> {
			const rootStore = useRootStore();
			const updatedSettings = await updateOtherUserSettings(
				rootStore.getRestApiContext,
				userId,
				settings,
			);
			this.users[userId].settings = updatedSettings;
			this.addUsers([this.users[userId]]);
		},
		async updateCurrentUserPassword({
			password,
			currentPassword,
		}: {
			password: string;
			currentPassword: string;
		}): Promise<void> {
			const rootStore = useRootStore();
			await updateCurrentUserPassword(rootStore.getRestApiContext, {
				newPassword: password,
				currentPassword,
			});
		},
		async deleteUser(params: { id: string; transferId?: string }): Promise<void> {
			const rootStore = useRootStore();
			await deleteUser(rootStore.getRestApiContext, params);
			this.deleteUserById(params.id);
		},
		async fetchUsers(): Promise<void> {
			const rootStore = useRootStore();
			const users = await getUsers(rootStore.getRestApiContext);
			this.addUsers(users);
		},
		async inviteUsers(params: Array<{ email: string }>): Promise<IInviteResponse[]> {
			const rootStore = useRootStore();
			const users = await inviteUsers(rootStore.getRestApiContext, params);
			this.addUsers(users.map(({ user }) => ({ isPending: true, ...user })));
			return users;
		},
		async reinviteUser(params: { email: string }): Promise<void> {
			const rootStore = useRootStore();
			const invitationResponse = await inviteUsers(rootStore.getRestApiContext, [
				{ email: params.email },
			]);
			if (!invitationResponse[0].user.emailSent) {
				throw Error(invitationResponse[0].error);
			}
		},
		async getUserPasswordResetLink(params: { id: string }): Promise<{ link: string }> {
			const rootStore = useRootStore();
			return getPasswordResetLink(rootStore.getRestApiContext, params);
		},
		async submitPersonalizationSurvey(results: IPersonalizationLatestVersion): Promise<void> {
			const rootStore = useRootStore();
			await submitPersonalizationSurvey(rootStore.getRestApiContext, results);
			this.setPersonalizationAnswers(results);
		},
		async showPersonalizationSurvey(): Promise<void> {
			const settingsStore = useSettingsStore();
			const surveyEnabled = settingsStore.isPersonalizationSurveyEnabled;
			const currentUser = this.currentUser;
			if (surveyEnabled && currentUser && !currentUser.personalizationAnswers) {
				const uiStore = useUIStore();
				uiStore.openModal(PERSONALIZATION_MODAL_KEY);
			}
		},
		async getMfaQR(): Promise<{ qrCode: string; secret: string; recoveryCodes: string[] }> {
			const rootStore = useRootStore();
			return getMfaQR(rootStore.getRestApiContext);
		},
		async verifyMfaToken(data: { token: string }): Promise<void> {
			const rootStore = useRootStore();
			return verifyMfaToken(rootStore.getRestApiContext, data);
		},
		async enableMfa(data: { token: string }) {
			const rootStore = useRootStore();
			const usersStore = useUsersStore();
			await enableMfa(rootStore.getRestApiContext, data);
			const currentUser = usersStore.currentUser;
			if (currentUser) {
				currentUser.mfaEnabled = true;
			}
		},
		async disabledMfa() {
			const rootStore = useRootStore();
			const usersStore = useUsersStore();
			await disableMfa(rootStore.getRestApiContext);
			const currentUser = usersStore.currentUser;
			if (currentUser) {
				currentUser.mfaEnabled = false;
			}
		},
		async fetchUserCloudAccount() {
			let cloudUser: Cloud.UserAccount | null = null;
			try {
				cloudUser = await getCloudUserInfo(useRootStore().getRestApiContext);
				this.currentUserCloudInfo = cloudUser;
			} catch (error) {
				throw new Error(error);
			}
		},
		async confirmEmail() {
			await confirmEmail(useRootStore().getRestApiContext);
		},
	},
});