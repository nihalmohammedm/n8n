<template>
	<transition name="slide">
		<slot />
	</transition>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
	name: 'SlideTransition',
});
</script>

<style lang="scss" scoped>
.slide-leave-active,
.slide-enter-active {
	transition: 200ms ease;
}
.slide-leave-to,
.slide-enter-from {
	transform: translateX(100%);
}
</style>
