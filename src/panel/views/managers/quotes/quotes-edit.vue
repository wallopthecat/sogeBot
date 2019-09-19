<template>
  <b-container fluid ref="window">
    <b-row>
      <b-col>
        <span class="title text-default mb-2">
          {{ translate('menu.manage') }}
          <small><i class="fas fa-angle-right"></i></small>
          {{ translate('menu.quotes') }}
          <template v-if="state.loaded === $state.success && $route.params.id">
            <small><i class="fas fa-angle-right"></i></small>
            {{item.name}}
            <small>{{$route.params.id}}</small>
          </template>
        </span>
      </b-col>
    </b-row>

    <panel>
      <template v-slot:left>
        <button-with-icon class="btn-secondary btn-reverse" icon="caret-left" href="#/manage/quotes/list">{{translate('commons.back')}}</button-with-icon>
        <hold-button v-if="$route.params.id && state.loaded === $state.success" icon="trash" class="btn-danger" @trigger="remove()">
          <template slot="title">{{translate('dialog.buttons.delete')}}</template>
          <template slot="onHoldTitle">{{translate('dialog.buttons.hold-to-delete')}}</template>
        </hold-button>
      </template>
      <template v-slot:right v-if="state.loaded === $state.success">
        <b-alert show variant="info" v-if="pending" v-html="translate('dialog.changesPending')" class="mr-2 p-2 mb-0"></b-alert>
        <state-button @click="save()" text="saveChanges" :state="state.save" :invalid="!!$v.$error"/>
      </template>
    </panel>

    <loading v-if="state.loaded !== $state.success" />
    <b-form v-else>
      <b-form-group
        :label="translate('systems.quotes.quote.name')"
        label-for="quote"
      >
        <b-form-input
          id="quote"
          v-model="item.quote"
          type="text"
          :placeholder="translate('systems.quotes.quote.placeholder')"
          @input="$v.item.quote.$touch()"
          :state="$v.item.quote.$invalid && $v.item.quote.$dirty ? 'invalid' : null"
        ></b-form-input>
        <b-form-invalid-feedback>{{ translate('dialog.errors.required') }}</b-form-invalid-feedback>
      </b-form-group>

      <b-form-group
        :label="translate('systems.quotes.by.name')"
        label-for="quotedBy"
      >
        <b-form-input
          id="quotedBy"
          :disabled="true"
          v-model="quotedByName"
          type="text"
        ></b-form-input>
      </b-form-group>

      <b-form-group
        :label="translate('systems.quotes.tags.name')"
        :description="translate('systems.quotes.tags.help')"
        label-for="tags"
      >
        <b-form-input
          id="tags"
          v-model="tagsString"
          type="text"
          :placeholder="translate('systems.quotes.tags.placeholder')"
        ></b-form-input>
      </b-form-group>
    </b-form>
  </b-container>
</template>

<script lang="ts">
import { Vue, Component, Watch } from 'vue-property-decorator';

import { Validations } from 'vuelidate-property-decorators';
import { required } from 'vuelidate/lib/validators';

import uuid from 'uuid/v4';

import { getUsernameById } from '../../../helpers/userById';
import { QuoteInterface } from '../../../../bot/systems/quotes';

Component.registerHooks([
  'beforeRouteEnter',
  'beforeRouteLeave',
  'beforeRouteUpdate' // for vue-router 2.2+
])

@Component({
  components: {
    'loading': () => import('../../../components/loading.vue'),
  },
  filters: {
    capitalize: function (value) {
      if (!value) return ''
      value = value.toString()
      return value.charAt(0).toUpperCase() + value.slice(1)
    }
  }
})
export default class QuotesEdit extends Vue {
  socket = io('/systems/quotes', { query: "token=" + this.token });

  error: any = null;

  state: { loaded: number; save: number } = { loaded: this.$state.progress, save: this.$state.idle }
  pending: boolean = false;

  item: QuoteInterface = {
    id: uuid(),
    createdAt: Date.now(),
    tags: [],
    quotedBy: '',
    quote: '',
  }

  tagsString: string = ''
  quotedByName: string = '';

  @Validations()
  validations = {
    item: {
      quote: {required},
    }
  }

  @Watch('item.tags')
  async watchTags(tags) {
    this.tagsString = tags.map(o => o.trim()).join(', ');
  }

  @Watch('tagsString')
  async watchTagsString(tags) {
    this.item.tags = tags.split(',').map(o => o.trim())
  }


  @Watch('item.quotedBy')
  async watchQuotedBy(id) {
    this.quotedByName = await getUsernameById(id);
  }

  async mounted() {
    this.state.loaded = this.$state.progress;
    if (this.$route.params.id) {
      this.socket.emit('findOne', { where: { id: this.$route.params.id } }, async (err, data: QuoteInterface) => {
        console.debug('Loaded', {data});
        this.item = data;
        this.state.loaded = this.$state.success;
        this.$nextTick(() => {
          this.pending = false;
        });
      })
    } else {
      this.item.quotedBy = this.$loggedUser.id;
      this.state.loaded = this.$state.success;
      this.$nextTick(() => {
        this.pending = false;
      });
    }
  }

  beforeRouteUpdate(to, from, next) {
    if (this.pending) {
      const isOK = confirm('You will lose your pending changes. Do you want to continue?')
      if (!isOK) {
        next(false);
      } else {
        next();
      }
    } else {
      next();
    }
  }

  beforeRouteLeave(to, from, next) {
    if (this.pending) {
      const isOK = confirm('You will lose your pending changes. Do you want to continue?')
      if (!isOK) {
        next(false);
      } else {
        next();
      }
    } else {
      next();
    }
  }

  @Watch('item', { deep: true })
  setPendingState() {
    if (this.state.loaded === this.$state.success) {
      this.pending = true;
    }
  }

  async remove () {
    await new Promise(resolve => {
      this.socket.emit('delete', { where: { id: this.$route.params.id } }, () => {
        resolve();
      })
    })
    this.$router.push({ name: 'QuotesManagerList' });
  }

  async save () {
    this.$v.$touch();
    if (!this.$v.$invalid) {
      this.state.save = this.$state.progress;
      console.debug('Saving', this.item);
      this.socket.emit('update', { key: 'id', items: [this.item] }, (err, data) => {
        if (err) {
          this.state.save = this.$state.fail;
          return console.error(err);
        }

        this.state.save = this.$state.success;
        this.pending = false;
        this.$router.push({ name: 'QuotesManagerEdit', params: { id: String(data.id) } }).catch(err => {})

        setTimeout(() => {
          this.state.save = this.$state.idle;
        }, 1000)
      });
    } else {
      setTimeout(() => {
        this.state.save = this.$state.idle;
      }, 1000)
    }
  }
}
</script>